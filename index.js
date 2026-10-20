import { mkdir, open, readFile, realpath, rename, rm, stat, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "1.1.0";
const PROJECT_FILE = "project.godot";
const MAX_PROJECT_FILE_BYTES = 2 * 1024 * 1024;
const MIN_GODOT_BRIDGE_PORT = 45000;
const GODOT_BRIDGE_PORT_RANGE = 10000;
const GODOT_BRIDGE_TIMEOUT_MS = 10000;
const GODOT_CAPTURE_TIMEOUT_MS = 30000;
const MAX_GODOT_BRIDGE_RESPONSE_BYTES = 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const GODOT_PLUGIN_DIRECTORY = "addons/godot_mcp_assistant";
const GODOT_PLUGIN_RESOURCE = "res://addons/godot_mcp_assistant/plugin.cfg";
const SERVER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

const server = new McpServer({
  name: "godot-mcp-assistant",
  version: VERSION
}, {
  maxToolInputElements: 50000
});

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

async function safeResolveWithin(root, relativePath, mustExist = false) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\0")) {
    throw new Error("A non-empty project-relative path is required.");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error("Absolute file paths are not allowed for project files; use a path relative to projectPath.");
  }

  const target = path.resolve(root, relativePath);
  if (!isInside(root, target)) {
    throw new Error("The requested path resolves outside the Godot project.");
  }

  let existingPath = target;
  while (true) {
    try {
      await lstat(existingPath);
      break;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw error;
      }
      const parent = path.dirname(existingPath);
      if (parent === existingPath) {
        throw new Error("Could not find a safe existing parent directory for the requested path.");
      }
      existingPath = parent;
    }
  }

  const canonicalExistingPath = await realpath(existingPath);
  if (!isInside(root, canonicalExistingPath)) {
    throw new Error("The requested path passes through a symbolic link outside the Godot project.");
  }

  if (mustExist) {
    const canonicalTarget = await realpath(target);
    if (!isInside(root, canonicalTarget)) {
      throw new Error("The requested file resolves outside the Godot project.");
    }
    return canonicalTarget;
  }

  return target;
}

async function getProject(projectPath) {
  if (!path.isAbsolute(projectPath)) {
    throw new Error("projectPath must be an absolute path to a Godot project directory.");
  }

  const root = await realpath(projectPath);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) {
    throw new Error("projectPath must point to a directory.");
  }

  const projectFile = await safeResolveWithin(root, PROJECT_FILE, true);
  const projectInfo = await stat(projectFile);
  if (!projectInfo.isFile()) {
    throw new Error("project.godot is not a regular file.");
  }

  return { root, projectFile };
}

function ensureSimpleName(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(label + " must start with a letter or underscore and contain only letters, digits, and underscores.");
  }
}

function defaultScript(baseClass) {
  if (baseClass === "CharacterBody2D") {
    return [
      "extends CharacterBody2D",
      "",
      "@export var speed: float = 300.0",
      "",
      "func _physics_process(_delta: float) -> void:",
      "    var direction := Input.get_vector(\"ui_left\", \"ui_right\", \"ui_up\", \"ui_down\")",
      "    velocity = direction * speed",
      "    move_and_slide()",
      ""
    ].join("\n");
  }

  if (baseClass === "CharacterBody3D") {
    return [
      "extends CharacterBody3D",
      "",
      "@export var speed: float = 5.0",
      "@export var jump_velocity: float = 4.5",
      "@export var gravity: float = 9.8",
      "",
      "func _physics_process(delta: float) -> void:",
      "    if not is_on_floor():",
      "        velocity.y -= gravity * delta",
      "    if Input.is_action_just_pressed(\"ui_accept\") and is_on_floor():",
      "        velocity.y = jump_velocity",
      "",
      "    var input_dir := Input.get_vector(\"ui_left\", \"ui_right\", \"ui_up\", \"ui_down\")",
      "    var direction := (transform.basis * Vector3(input_dir.x, 0.0, input_dir.y)).normalized()",
      "    velocity.x = direction.x * speed",
      "    velocity.z = direction.z * speed",
      "    move_and_slide()",
      ""
    ].join("\n");
  }

  return [
    "extends " + baseClass,
    "",
    "func _ready() -> void:",
    "    pass",
    ""
  ].join("\n");
}

function buildScript(baseClass, suppliedContent) {
  ensureSimpleName(baseClass, "baseClass");

  if (suppliedContent === undefined || suppliedContent.trim().length === 0) {
    return defaultScript(baseClass);
  }

  const content = suppliedContent.replace(/^\uFEFF/, "").trimStart();
  const declaration = content.match(/^\s*extends\s+([A-Za-z_][A-Za-z0-9_]*)\b/m);
  if (declaration && declaration[1] !== baseClass) {
    throw new Error("scriptContent extends " + declaration[1] + " but baseClass is " + baseClass + ".");
  }

  if (declaration) {
    return content.endsWith("\n") ? content : content + "\n";
  }

  return "extends " + baseClass + "\n\n" + content.replace(/\s+$/, "") + "\n";
}

async function writeNewFile(filePath, content, overwrite) {
  if (overwrite) {
    await writeFile(filePath, content, "utf8");
    return;
  }

  const handle = await open(filePath, "wx");
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function writeFileAtomically(filePath, content) {
  const tempPath = path.join(path.dirname(filePath), "." + path.basename(filePath) + "." + randomUUID() + ".tmp");
  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

const propertySchema = z.record(z.string(), z.unknown());

const sceneNodeSchema = z.lazy(() => z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  properties: propertySchema.optional(),
  groups: z.array(z.string()).optional(),
  owner: z.string().optional(),
  instanceResourceId: z.string().optional(),
  children: z.array(sceneNodeSchema).optional()
}));

const sceneSchema = z.object({
  root: sceneNodeSchema,
  resources: z.array(z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    path: z.string().min(1)
  })).optional(),
  subResources: z.array(z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    properties: propertySchema.optional()
  })).optional()
});

function quote(value) {
  return JSON.stringify(value);
}

function assertSingleLine(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new Error(label + " must be a non-empty, single-line string.");
  }
}

function serializeGodotValue(value, externalIds, subResourceIds) {
  if (value === null) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Scene properties cannot contain non-finite numbers.");
    return Object.is(value, -0) ? "0" : String(value);
  }

  if (Array.isArray(value)) {
    return "[" + value.map(item => serializeGodotValue(item, externalIds, subResourceIds)).join(", ") + "]";
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$expression") {
      const expression = value.$expression;
      assertSingleLine(expression, "$expression");
      return expression;
    }
    if (keys.length === 1 && keys[0] === "$extResource") {
      const id = value.$extResource;
      if (!externalIds.has(id)) throw new Error("Unknown external resource id: " + id);
      return "ExtResource(" + quote(id) + ")";
    }
    if (keys.length === 1 && keys[0] === "$subResource") {
      const id = value.$subResource;
      if (!subResourceIds.has(id)) throw new Error("Unknown sub-resource id: " + id);
      return "SubResource(" + quote(id) + ")";
    }

    const entries = keys.map(key => {
      return quote(key) + ": " + serializeGodotValue(value[key], externalIds, subResourceIds);
    });
    return entries.length === 0 ? "{ }" : "{ " + entries.join(", ") + " }";
  }

  throw new Error("Unsupported value in scene properties.");
}

function buildScene(scene) {
  const resources = scene.resources ?? [];
  const subResources = scene.subResources ?? [];
  if (resources.length + subResources.length > 2000) {
    throw new Error("A scene cannot contain more than 2,000 declared resources.");
  }
  const allIds = new Set();
  const externalIds = new Set();
  const subResourceIds = new Set();

  for (const resource of resources) {
    ensureSimpleName(resource.id, "Resource id");
    if (allIds.has(resource.id)) throw new Error("Duplicate scene resource id: " + resource.id);
    allIds.add(resource.id);
    externalIds.add(resource.id);
    assertSingleLine(resource.type, "External resource type");
    if (!resource.path.startsWith("res://")) {
      throw new Error("External resource paths must start with res://.");
    }
    assertSingleLine(resource.path, "External resource path");
  }

  for (const resource of subResources) {
    ensureSimpleName(resource.id, "Sub-resource id");
    if (allIds.has(resource.id)) throw new Error("Duplicate scene resource id: " + resource.id);
    allIds.add(resource.id);
    subResourceIds.add(resource.id);
    assertSingleLine(resource.type, "Sub-resource type");
  }

  const lines = [
    "[gd_scene load_steps=" + (1 + resources.length + subResources.length) + " format=3]"
  ];

  for (const resource of resources) {
    lines.push(
      "[ext_resource type=" + quote(resource.type) +
      " path=" + quote(resource.path) +
      " id=" + quote(resource.id) + "]"
    );
  }

  for (const resource of subResources) {
    lines.push("");
    lines.push("[sub_resource type=" + quote(resource.type) + " id=" + quote(resource.id) + "]");
    for (const [property, value] of Object.entries(resource.properties ?? {})) {
      assertSingleLine(property, "Sub-resource property name");
      lines.push(property + " = " + serializeGodotValue(value, externalIds, subResourceIds));
    }
  }

  const nodePaths = new Set();
  let nodeCount = 0;

  function emitNode(node, parentPath, siblingNames, depth = 0) {
    if (depth > 128) {
      throw new Error("Scene node nesting cannot exceed 128 levels.");
    }
    nodeCount += 1;
    if (nodeCount > 5000) {
      throw new Error("A scene cannot contain more than 5,000 nodes.");
    }

    assertSingleLine(node.name, "Node name");
    if (node.name === "." || node.name === ".." || node.name.includes("/") || node.name.includes("\\")) {
      throw new Error("Node names cannot be ., .., or contain a path separator.");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(node.type)) {
      throw new Error("Node type must be a Godot class or script class identifier.");
    }
    if (siblingNames.has(node.name)) {
      throw new Error("Sibling nodes must have unique names: " + node.name);
    }
    siblingNames.add(node.name);

    const nodePath = parentPath === "" || parentPath === "." ? node.name : parentPath + "/" + node.name;
    if (nodePaths.has(nodePath)) throw new Error("Duplicate scene node path: " + nodePath);
    nodePaths.add(nodePath);

    const attributes = ["name=" + quote(node.name), "type=" + quote(node.type)];
    if (parentPath !== "") attributes.push("parent=" + quote(parentPath));
    if (node.instanceResourceId !== undefined) {
      if (!externalIds.has(node.instanceResourceId)) {
        throw new Error("Unknown instance resource id: " + node.instanceResourceId);
      }
      attributes.push("instance=ExtResource(" + quote(node.instanceResourceId) + ")");
    }
    if (node.groups?.length) {
      attributes.push("groups=[" + node.groups.map(group => quote(group)).join(", ") + "]");
    }
    if (node.owner !== undefined) {
      assertSingleLine(node.owner, "Node owner");
      attributes.push("owner=" + quote(node.owner));
    }

    lines.push("");
    lines.push("[node " + attributes.join(" ") + "]");
    for (const [property, value] of Object.entries(node.properties ?? {})) {
      assertSingleLine(property, "Node property name");
      lines.push(property + " = " + serializeGodotValue(value, externalIds, subResourceIds));
    }

    const childNames = new Set();
    const childParentPath = parentPath === "" ? "." : nodePath;
    for (const child of node.children ?? []) {
      emitNode(child, childParentPath, childNames, depth + 1);
    }
  }

  emitNode(scene.root, "", new Set());
  return lines.join("\n") + "\n";
}

function splitTopLevel(value, separator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quoteChar = "";
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoteChar) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quoteChar) {
        quoteChar = "";
      }
      continue;
    }

    if (character === "\"" || character === "'") {
      quoteChar = character;
    } else if (character === "[" || character === "{" || character === "(") {
      depth += 1;
    } else if (character === "]" || character === "}" || character === ")") {
      depth -= 1;
    } else if (character === separator && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(value.slice(start).trim());
  return parts.filter(part => part.length > 0);
}

function findTopLevelColon(value) {
  let depth = 0;
  let quoteChar = "";
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoteChar) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quoteChar) {
        quoteChar = "";
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quoteChar = character;
    } else if (character === "[" || character === "{" || character === "(") {
      depth += 1;
    } else if (character === "]" || character === "}" || character === ")") {
      depth -= 1;
    } else if (character === ":" && depth === 0) {
      return index;
    }
  }
  return -1;
}

function parseGodotValue(rawValue) {
  const value = rawValue.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value);
    } catch {
      return rawValue;
    }
  }
  const packedArray = value.match(/^(?:PackedStringArray|PackedInt32Array|PackedInt64Array|PackedFloat32Array|PackedFloat64Array|Array)\((.*)\)$/s);
  if (packedArray) {
    const inside = packedArray[1].trim();
    return inside.length === 0 ? [] : splitTopLevel(inside, ",").map(parseGodotValue);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inside = value.slice(1, -1).trim();
    return inside.length === 0 ? [] : splitTopLevel(inside, ",").map(parseGodotValue);
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const inside = value.slice(1, -1).trim();
    if (inside.length === 0) return {};
    const result = Object.create(null);
    for (const entry of splitTopLevel(inside, ",")) {
      const colonIndex = findTopLevelColon(entry);
      if (colonIndex < 0) return rawValue;
      let key = entry.slice(0, colonIndex).trim();
      if (key.startsWith("\"") && key.endsWith("\"")) {
        try {
          key = JSON.parse(key);
        } catch {
          return rawValue;
        }
      }
      result[String(key)] = parseGodotValue(entry.slice(colonIndex + 1));
    }
    return result;
  }
  return rawValue;
}

function parseProjectConfig(text) {
  const sections = Object.create(null);
  let sectionName = "";
  sections[sectionName] = Object.create(null);
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);

  for (const originalLine of lines) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      sectionName = sectionMatch[1].trim();
      sections[sectionName] ??= Object.create(null);
      continue;
    }

    const equalsIndex = originalLine.indexOf("=");
    if (equalsIndex < 0) continue;
    const key = originalLine.slice(0, equalsIndex).trim();
    if (!key) continue;
    const raw = originalLine.slice(equalsIndex + 1).trim();
    sections[sectionName] ??= Object.create(null);
    sections[sectionName][key] = { raw, value: parseGodotValue(raw) };
  }

  return sections;
}

async function getProjectText(projectFile) {
  const info = await stat(projectFile);
  if (info.size > MAX_PROJECT_FILE_BYTES) {
    throw new Error("project.godot is larger than the 2 MiB safety limit.");
  }
  return readFile(projectFile, "utf8");
}

function updateProjectSetting(text, sectionName, key, rawValue) {
  const newline = text.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  const hadTrailingNewline = /(?:\r\n|\n|\r)$/.test(text);
  const lines = text.split(/\r\n|\n|\r/);
  const sectionPattern = new RegExp("^\\s*\\[" + sectionName + "\\]\\s*(?:[#;].*)?$");
  const sectionStart = lines.findIndex(line => sectionPattern.test(line));

  if (sectionStart < 0) {
    if (lines[lines.length - 1] === "") lines.pop();
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push("[" + sectionName + "]");
    lines.push(key + "=" + rawValue);
  } else {
    let sectionEnd = lines.length;
    for (let index = sectionStart + 1; index < lines.length; index += 1) {
      if (/^\s*\[[^\]]+\]/.test(lines[index])) {
        sectionEnd = index;
        break;
      }
    }

    const matchingLines = [];
    for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
      const equalsIndex = lines[index].indexOf("=");
      if (equalsIndex >= 0 && lines[index].slice(0, equalsIndex).trim() === key) matchingLines.push(index);
    }
    if (matchingLines.length === 0) {
      lines.splice(sectionEnd, 0, key + "=" + rawValue);
    } else {
      lines[matchingLines[0]] = key + "=" + rawValue;
      for (let index = matchingLines.length - 1; index >= 1; index -= 1) lines.splice(matchingLines[index], 1);
    }
  }

  let updatedText = lines.join(newline);
  if (hadTrailingNewline && !updatedText.endsWith(newline)) updatedText += newline;
  return updatedText;
}

function enableGodotEditorPlugin(text) {
  const sections = parseProjectConfig(text);
  const enabledEntry = sections.editor_plugins?.enabled;
  let enabledPlugins = [];
  if (enabledEntry !== undefined) {
    if (!Array.isArray(enabledEntry.value) || enabledEntry.value.some(item => typeof item !== "string")) {
      throw new Error("Cannot safely update [editor_plugins] enabled; its value is not a supported string array.");
    }
    enabledPlugins = enabledEntry.value;
  }
  if (enabledPlugins.includes(GODOT_PLUGIN_RESOURCE)) return text;
  enabledPlugins.push(GODOT_PLUGIN_RESOURCE);
  const serialized = "PackedStringArray(" + enabledPlugins.map(value => JSON.stringify(value)).join(", ") + ")";
  return updateProjectSetting(text, "editor_plugins", "enabled", serialized);
}

function suggestGodotBridgePort(projectRoot) {
  const digest = createHash("sha256").update(projectRoot.toLowerCase()).digest("hex");
  return MIN_GODOT_BRIDGE_PORT + Number.parseInt(digest.slice(0, 8), 16) % GODOT_BRIDGE_PORT_RANGE;
}

async function getGodotBridgePort(projectFile) {
  const sections = parseProjectConfig(await getProjectText(projectFile));
  const value = sections.godot_mcp_assistant?.bridge_port?.value;
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("The Godot editor bridge is not installed for this project. Call install_godot_editor_bridge, then restart the Godot editor.");
  }
  return value;
}

async function requestGodotBridge(port, command, payload = {}, timeoutMs = GODOT_BRIDGE_TIMEOUT_MS) {
  const requestId = randomUUID();
  const requestText = JSON.stringify({ id: requestId, command, ...payload }) + "\n";
  const offlineHint = " Open the Godot project in the editor, install the bridge with install_godot_editor_bridge, and restart the editor.";

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let responseText = "";
    let settled = false;
    const timeout = setTimeout(() => {
      fail(new Error("Timed out waiting for the Godot editor bridge on 127.0.0.1:" + port + "." + offlineHint));
    }, timeoutMs);
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    };

    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(requestText));
    socket.on("data", chunk => {
      responseText += chunk;
      if (Buffer.byteLength(responseText, "utf8") > MAX_GODOT_BRIDGE_RESPONSE_BYTES) {
        fail(new Error("Godot editor bridge response exceeded the 1 MiB safety limit."));
        return;
      }
      const newlineIndex = responseText.indexOf("\n");
      if (newlineIndex < 0) return;
      let response;
      try {
        response = JSON.parse(responseText.slice(0, newlineIndex));
      } catch {
        fail(new Error("Godot editor bridge returned malformed JSON."));
        return;
      }
      if (response.id !== requestId) {
        fail(new Error("Godot editor bridge response ID did not match the request."));
        return;
      }
      if (response.ok !== true) {
        fail(new Error(response.error || "Godot editor bridge rejected the request."));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.end();
      resolve(response.result ?? {});
    });
    socket.once("error", error => {
      fail(new Error("Could not connect to the Godot editor bridge on 127.0.0.1:" + port + ": " + error.message + "." + offlineHint));
    });
    socket.once("end", () => {
      if (!settled) fail(new Error("Godot editor bridge closed the connection before replying." + offlineHint));
    });
  });
}

function toGodotResourcePath(projectRoot, absolutePath) {
  return "res://" + path.relative(projectRoot, absolutePath).split(path.sep).join("/");
}

function registerTool(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async args => {
    try {
      const data = await handler(args);
      if (data && Array.isArray(data.mcpContent)) return { content: data.mcpContent };
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: error instanceof Error ? error.message : String(error)
        }]
      };
    }
  });
}

registerTool(
  "create_gdscript",
  "Create a GDScript file inside a Godot project. If content is omitted, generate a starter script; CharacterBody2D and CharacterBody3D get working movement examples.",
  {
    projectPath: z.string().min(1).describe("Absolute path to a directory containing project.godot."),
    scriptPath: z.string().min(1).describe("Path to the new .gd file relative to projectPath."),
    baseClass: z.string().min(1).default("Node").describe("Godot base class, for example Node, CharacterBody2D, Area2D, or CharacterBody3D."),
    content: z.string().optional().describe("Optional complete GDScript source. An extends declaration is added when missing and must match baseClass when present."),
    overwrite: z.boolean().optional().default(false).describe("Replace an existing file. Defaults to false.")
  },
  async ({ projectPath, scriptPath, baseClass, content, overwrite }) => {
    const { root } = await getProject(projectPath);
    if (path.extname(scriptPath).toLowerCase() !== ".gd") {
      throw new Error("scriptPath must use the .gd extension.");
    }

    const target = await safeResolveWithin(root, scriptPath);
    await mkdir(path.dirname(target), { recursive: true });
    await safeResolveWithin(root, scriptPath);
    const source = buildScript(baseClass, content);
    await writeNewFile(target, source, overwrite);

    return {
      created: true,
      filePath: target,
      relativePath: path.relative(root, target),
      baseClass,
      bytesWritten: Buffer.byteLength(source, "utf8")
    };
  }
);

registerTool(
  "generate_tscn_scene",
  "Generate a Godot 4 text scene (.tscn) from a JSON scene tree, resources, sub-resources, groups, node properties, and optional scene instances.",
  {
    projectPath: z.string().min(1).describe("Absolute path to a directory containing project.godot."),
    scenePath: z.string().min(1).describe("Path to the .tscn file relative to projectPath."),
    scene: sceneSchema.describe("Scene data containing root, optional resources, optional subResources, and nested children."),
    overwrite: z.boolean().optional().default(false).describe("Replace an existing scene. Defaults to false.")
  },
  async ({ projectPath, scenePath, scene, overwrite }) => {
    const { root } = await getProject(projectPath);
    if (path.extname(scenePath).toLowerCase() !== ".tscn") {
      throw new Error("scenePath must use the .tscn extension.");
    }

    const target = await safeResolveWithin(root, scenePath);
    await mkdir(path.dirname(target), { recursive: true });
    await safeResolveWithin(root, scenePath);
    const source = buildScene(scene);
    await writeNewFile(target, source, overwrite);

    return {
      created: true,
      filePath: target,
      relativePath: path.relative(root, target),
      nodeCount: (source.match(/^\[node /gm) ?? []).length,
      bytesWritten: Buffer.byteLength(source, "utf8")
    };
  }
);

registerTool(
  "analyze_project_godot",
  "Read and parse project.godot. Returns parsed sections and raw values, with convenient input map, plugin, autoload, and project-name fields.",
  {
    projectPath: z.string().min(1).describe("Absolute path to a directory containing project.godot.")
  },
  async ({ projectPath }) => {
    const { root, projectFile } = await getProject(projectPath);
    const configText = await getProjectText(projectFile);
    const sections = parseProjectConfig(configText);
    const projectName = sections.application?.["config/name"]?.value ?? null;
    const pluginSection = sections.editor_plugins ?? sections.plugins ?? {};
    const globalSettings = Object.fromEntries(
      Object.entries(sections).filter(([name]) => !["input", "autoload", "editor_plugins", "plugins"].includes(name))
    );

    return {
      projectPath: root,
      projectName,
      inputMap: sections.input ?? {},
      plugins: {
        enabled: pluginSection.enabled?.value ?? [],
        raw: pluginSection.enabled?.raw ?? null
      },
      autoload: sections.autoload ?? {},
      globalSettings,
      sections,
      parsingNote: "Each setting includes its original raw value. Godot constructors and unsupported Variant expressions are preserved as raw strings."
    };
  }
);

registerTool(
  "inject_script_autoload",
  "Add a GDScript as a Godot global Autoload singleton by editing project.godot. The script must exist in the project and use a res:// path.",
  {
    projectPath: z.string().min(1).describe("Absolute path to a directory containing project.godot."),
    singletonName: z.string().min(1).describe("Global singleton name, for example GameState."),
    scriptPath: z.string().min(7).describe("Existing script resource path such as res://scripts/game_state.gd."),
    replaceExisting: z.boolean().optional().default(false).describe("Allow changing an existing singleton with the same name. Defaults to false.")
  },
  async ({ projectPath, singletonName, scriptPath, replaceExisting }) => {
    ensureSimpleName(singletonName, "singletonName");
    if (!scriptPath.startsWith("res://")) {
      throw new Error("scriptPath must start with res://.");
    }
    if (path.posix.extname(scriptPath).toLowerCase() !== ".gd" || /[\r\n\0]/.test(scriptPath)) {
      throw new Error("scriptPath must be a single-line res:// path ending in .gd.");
    }

    const { root, projectFile } = await getProject(projectPath);
    const relativeScriptPath = scriptPath.slice("res://".length).split("/").join(path.sep);
    if (!relativeScriptPath) throw new Error("scriptPath must point to a script inside the project.");
    const resolvedScriptPath = await safeResolveWithin(root, relativeScriptPath, true);
    if (!(await stat(resolvedScriptPath)).isFile()) {
      throw new Error("scriptPath must point to a file.");
    }

    const originalText = await getProjectText(projectFile);
    const newline = originalText.includes("\r\n") ? "\r\n" : "\n";
    const hadTrailingNewline = /(?:\r\n|\n|\r)$/.test(originalText);
    const lines = originalText.split(/\r\n|\n|\r/);
    const sectionStart = lines.findIndex(line => /^\s*\[autoload\]\s*(?:[#;].*)?$/.test(line));
    const expectedValue = JSON.stringify("*" + scriptPath);
    let changed = false;

    if (sectionStart < 0) {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      lines.push("[autoload]");
      lines.push(singletonName + "=" + expectedValue);
      changed = true;
    } else {
      let sectionEnd = lines.length;
      for (let index = sectionStart + 1; index < lines.length; index += 1) {
        if (/^\s*\[[^\]]+\]/.test(lines[index])) {
          sectionEnd = index;
          break;
        }
      }

      const matchingLines = [];
      for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
        const equalsIndex = lines[index].indexOf("=");
        if (equalsIndex >= 0 && lines[index].slice(0, equalsIndex).trim() === singletonName) {
          matchingLines.push(index);
        }
      }

      if (matchingLines.length === 0) {
        lines.splice(sectionEnd, 0, singletonName + "=" + expectedValue);
        changed = true;
      } else {
        const firstIndex = matchingLines[0];
        const currentValue = lines[firstIndex].slice(lines[firstIndex].indexOf("=") + 1).trim();
        if (currentValue !== expectedValue && !replaceExisting) {
          throw new Error("An Autoload named " + singletonName + " already points to another script. Set replaceExisting=true to change it.");
        }
        if (currentValue !== expectedValue) {
          lines[firstIndex] = singletonName + "=" + expectedValue;
          changed = true;
        }
        for (let duplicateIndex = matchingLines.length - 1; duplicateIndex >= 1; duplicateIndex -= 1) {
          lines.splice(matchingLines[duplicateIndex], 1);
          changed = true;
        }
      }
    }

    if (changed) {
      let updatedText = lines.join(newline);
      if (hadTrailingNewline && !updatedText.endsWith(newline)) updatedText += newline;
      await writeFileAtomically(projectFile, updatedText);
    }

    return {
      changed,
      projectFile,
      singletonName,
      scriptPath,
      value: "*" + scriptPath
    };
  }
);

registerTool(
  "install_godot_editor_bridge",
  "Install the Godot editor add-on into a Godot project, configure its localhost bridge port, and enable it in project.godot. Restart the Godot editor after installation.",
  {
    projectPath: z.string().min(1).describe("Absolute path to a directory containing project.godot."),
    overwrite: z.boolean().optional().default(false).describe("Replace bridge files that differ from this server's bundled version. Defaults to false.")
  },
  async ({ projectPath, overwrite }) => {
    const { root, projectFile } = await getProject(projectPath);
    const files = [];
    const writtenFiles = [];
    await safeResolveWithin(root, GODOT_PLUGIN_DIRECTORY);

    for (const fileName of ["plugin.cfg", "plugin.gd"]) {
      const sourcePath = path.join(SERVER_DIRECTORY, "godot_plugin", GODOT_PLUGIN_DIRECTORY, fileName);
      const relativePath = path.join(GODOT_PLUGIN_DIRECTORY, fileName);
      const destination = await safeResolveWithin(root, relativePath);
      const bundledContent = await readFile(sourcePath, "utf8");
      let existingContent;
      try {
        existingContent = await readFile(destination, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (existingContent !== undefined && existingContent !== bundledContent && !overwrite) {
        throw new Error("An existing Godot bridge file differs from the bundled version: " + relativePath + ". Set overwrite=true to replace it.");
      }
      files.push({ relativePath, destination, bundledContent, existingContent });
    }

    const originalText = await getProjectText(projectFile);
    const sections = parseProjectConfig(originalText);
    const currentPort = sections.godot_mcp_assistant?.bridge_port?.value;
    const port = Number.isInteger(currentPort) && currentPort >= 1024 && currentPort <= 65535
      ? currentPort
      : suggestGodotBridgePort(root);
    let updatedText = updateProjectSetting(originalText, "godot_mcp_assistant", "bridge_port", String(port));
    updatedText = enableGodotEditorPlugin(updatedText);
    const projectSettingsChanged = updatedText !== originalText;

    await mkdir(path.join(root, GODOT_PLUGIN_DIRECTORY), { recursive: true });
    for (const file of files) {
      const destination = await safeResolveWithin(root, file.relativePath);
      if (file.existingContent === file.bundledContent) continue;
      if (file.existingContent === undefined) await writeNewFile(destination, file.bundledContent, false);
      else await writeFileAtomically(destination, file.bundledContent);
      writtenFiles.push(destination);
    }
    if (projectSettingsChanged) await writeFileAtomically(projectFile, updatedText);

    return {
      installed: true,
      projectPath: root,
      pluginPath: path.join(root, GODOT_PLUGIN_DIRECTORY),
      enabledPlugin: GODOT_PLUGIN_RESOURCE,
      bridgePort: port,
      writtenFiles,
      projectSettingsChanged,
      restartGodotEditor: true,
      note: "The bridge listens only on 127.0.0.1. Restart the Godot editor to load the add-on and open the local bridge."
    };
  }
);

registerTool(
  "godot_editor_status",
  "Connect to the Godot editor add-on and report the editor version, current scene, play state, project path, and bridge port.",
  { projectPath: z.string().min(1).describe("Absolute path to a directory containing project.godot.") },
  async ({ projectPath }) => {
    const { projectFile } = await getProject(projectPath);
    const port = await getGodotBridgePort(projectFile);
    return requestGodotBridge(port, "ping");
  }
);

registerTool(
  "godot_open_scene",
  "Open an existing .tscn or .scn scene in the connected Godot editor.",
  {
    projectPath: z.string().min(1).describe("Absolute path to a directory containing project.godot."),
    scenePath: z.string().min(1).describe("Path to an existing .tscn or .scn scene relative to projectPath.")
  },
  async ({ projectPath, scenePath }) => {
    const { root, projectFile } = await getProject(projectPath);
    if (![".tscn", ".scn"].includes(path.extname(scenePath).toLowerCase())) throw new Error("scenePath must use the .tscn or .scn extension.");
    const target = await safeResolveWithin(root, scenePath, true);
    if (!(await stat(target)).isFile()) throw new Error("scenePath must point to a file.");
    const port = await getGodotBridgePort(projectFile);
    return requestGodotBridge(port, "open_scene", { scene_path: toGodotResourcePath(root, target) });
  }
);

registerTool(
  "godot_play_scene",
  "Run a scene in the connected Godot editor. If scenePath is omitted, run the currently open scene.",
  {
    projectPath: z.string().min(1).describe("Absolute path to a directory containing project.godot."),
    scenePath: z.string().optional().describe("Optional existing .tscn or .scn path relative to projectPath.")
  },
  async ({ projectPath, scenePath }) => {
    const { root, projectFile } = await getProject(projectPath);
    let resourcePath = "";
    if (scenePath !== undefined && scenePath.length > 0) {
      if (![".tscn", ".scn"].includes(path.extname(scenePath).toLowerCase())) throw new Error("scenePath must use the .tscn or .scn extension.");
      const target = await safeResolveWithin(root, scenePath, true);
      if (!(await stat(target)).isFile()) throw new Error("scenePath must point to a file.");
      resourcePath = toGodotResourcePath(root, target);
    }
    const port = await getGodotBridgePort(projectFile);
    return requestGodotBridge(port, "play_scene", { scene_path: resourcePath });
  }
);

registerTool(
  "godot_stop_scene",
  "Stop the scene currently running from the connected Godot editor.",
  { projectPath: z.string().min(1).describe("Absolute path to a directory containing project.godot.") },
  async ({ projectPath }) => {
    const { projectFile } = await getProject(projectPath);
    const port = await getGodotBridgePort(projectFile);
    return requestGodotBridge(port, "stop_scene");
  }
);

registerTool(
  "capture_godot_viewport",
  "Capture the Godot editor's current 2D or 3D viewport and return the screenshot as a PNG image.",
  {
    projectPath: z.string().min(1).describe("Absolute path to a directory containing project.godot."),
    viewport: z.enum(["2d", "3d"]).optional().default("2d").describe("Godot editor viewport to capture.")
  },
  async ({ projectPath, viewport }) => {
    const { projectFile } = await getProject(projectPath);
    const port = await getGodotBridgePort(projectFile);
    const outputPath = path.join(os.tmpdir(), "godot-mcp-assistant-" + randomUUID() + ".png");
    try {
      const capture = await requestGodotBridge(port, "capture_viewport", { viewport, output_path: outputPath }, GODOT_CAPTURE_TIMEOUT_MS);
      if (path.resolve(capture.output_path ?? "") !== path.resolve(outputPath)) throw new Error("Godot returned a screenshot path that did not match the requested temporary file.");
      const info = await stat(outputPath);
      if (!info.isFile() || info.size < 8 || info.size > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot is empty or exceeds the 20 MiB safety limit.");
      const image = await readFile(outputPath);
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (!image.subarray(0, 8).equals(pngSignature)) throw new Error("Godot returned a file that is not a PNG image.");
      return {
        mcpContent: [
          { type: "text", text: "Captured the Godot " + viewport + " editor viewport (" + capture.width + " × " + capture.height + "); PNG attached." },
          { type: "image", data: image.toString("base64"), mimeType: "image/png" }
        ]
      };
    } finally {
      await rm(outputPath, { force: true }).catch(() => {});
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
