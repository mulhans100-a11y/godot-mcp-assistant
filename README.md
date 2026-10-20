# Godot MCP Assistant

Godot MCP Assistant is a local Model Context Protocol (MCP) server for Godot 4 projects. It lets AI clients such as Cursor, Claude Desktop, and OpenAI Codex inspect project settings, create GDScript and text-scene files, and communicate with the Godot editor.

The Node.js server communicates with MCP clients over stdio. Its file tools work while Godot is closed. An optional Godot editor add-on adds a loopback bridge for opening and running scenes and capturing the editor's 2D or 3D viewport.

## Features

- **create_gdscript** — writes a GDScript file with a chosen base class. When source is omitted, it creates a starter script; <code>CharacterBody2D</code> and <code>CharacterBody3D</code> receive movement examples.
- **generate_tscn_scene** — converts a JSON scene tree into a Godot 4 <code>.tscn</code> file, including external resources, sub-resources, node properties, groups, and instanced scenes.
- **analyze_project_godot** — reads <code>project.godot</code> and returns the input map, enabled plugins, autoloads, global settings, parsed values, and original raw values.
- **inject_script_autoload** — adds an existing <code>res://</code> GDScript as an Autoload singleton in <code>project.godot</code>.
- **install_godot_editor_bridge** — installs and enables the optional Godot editor add-on in a project.
- **godot_editor_status**, **godot_open_scene**, **godot_play_scene**, and **godot_stop_scene** — inspect and control the connected editor.
- **capture_godot_viewport** — returns a PNG image of the current Godot editor 2D or 3D viewport.

The tools expect the absolute path of a directory containing <code>project.godot</code>. Paths for files the server creates must be relative to that project directory.

## Requirements

- Node.js 18 or newer
- A Godot 4 project with a <code>project.godot</code> file
- An MCP-compatible client that can launch a local stdio server
- Godot 4.0 or newer for editor bridge controls; viewport screenshots require Godot 4.2 or newer

## Install

Clone this repository, then install its dependencies:

~~~sh
git clone https://github.com/YOUR-USERNAME/godot-mcp-assistant.git
cd godot-mcp-assistant
npm install
~~~

Run the server directly with:

~~~sh
npm start
~~~

The process waits for an MCP client on stdin and writes protocol messages to stdout. Do not add ordinary log output to stdout.

## Connect the Godot editor

The file tools need no running Godot process. To open scenes, run or stop them, and capture editor viewport screenshots:

1. Connect this MCP server to your client.
2. Ask the assistant to call <code>install_godot_editor_bridge</code> with the target project's absolute <code>projectPath</code>. The tool copies the add-on into <code>addons/godot_mcp_assistant</code>, enables it in <code>project.godot</code>, and assigns a project-specific localhost port.
3. Open or restart the project in the Godot editor. If it was already open during installation, restart it so Godot loads the add-on. Call <code>godot_editor_status</code> to confirm the bridge is connected.

The bridge listens only on <code>127.0.0.1</code>. Use <code>godot_open_scene</code> to open a scene, <code>godot_play_scene</code> to run it, and <code>godot_stop_scene</code> to stop it. Call <code>capture_godot_viewport</code> with <code>viewport</code> set to <code>2d</code> or <code>3d</code> to attach a PNG of the editor viewport to the tool result. The screenshot is an editor viewport capture, not a recording or screenshot of the separate running game window.

Godot 4.0 and 4.1 can use the editor control tools. Godot added the editor viewport accessors needed for screenshots in 4.2, so screenshots require 4.2 or newer. The add-on is bundled under <code>godot_plugin/addons/godot_mcp_assistant</code> and is copied into each game project by the install tool.

## Connect Codex

Codex CLI and the Codex IDE extension share the MCP configuration. From PowerShell, add this local stdio server with the Codex CLI. Replace the example path with the location of this repository:

~~~powershell
codex mcp add godot-mcp-assistant -- node "C:\path\to\godot-mcp-assistant\index.js"
codex mcp list
~~~

Restart Codex after adding the server. The tools should then appear in Codex's MCP tool list.

You can also add the server manually to <code>~/.codex/config.toml</code> (on Windows, usually <code>%USERPROFILE%\\.codex\\config.toml</code>):

~~~toml
[mcp_servers.godot-mcp-assistant]
command = "node"
args = ["C:\\path\\to\\godot-mcp-assistant\\index.js"]
enabled = true
~~~

See OpenAI's [Codex MCP setup guide](https://developers.openai.com/resources/docs-mcp) and [Codex configuration reference](https://developers.openai.com/codex/config-reference).

## Connect Cursor

Add the server to the project-specific <code>.cursor/mcp.json</code> file in the game project, or to Cursor's global MCP configuration. Replace the example path with the location of this repository on your machine.

~~~json
{
  "mcpServers": {
    "godot-mcp-assistant": {
      "command": "node",
      "args": ["C:\\path\\to\\godot-mcp-assistant\\index.js"]
    }
  }
}
~~~

Restart Cursor or reload its MCP servers. Confirm that the Godot tools appear in the available tools list. Cursor documents project-specific configuration in its [MCP guide](https://docs.cursor.com/context/model-context-protocol).

## Connect Claude Desktop

### Install as a Claude Desktop extension

This repository includes an MCP Bundle manifest. From the repository directory, install dependencies and create the extension bundle:

~~~sh
npm install
npm install -g @anthropic-ai/mcpb
mcpb validate manifest.json
mcpb pack . godot-mcp-assistant.mcpb
~~~

In Claude Desktop, open **Settings → Extensions → Advanced settings → Install Extension…** and select the generated <code>godot-mcp-assistant.mcpb</code> file. Restart Claude Desktop if it does not appear immediately. The bundle starts the local Node.js server; the AI client supplies the absolute Godot project path in each tool call.

See Anthropic's [local MCP server guide](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) and the [MCPB manifest specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md).

### Manual stdio configuration

For clients or Claude Desktop installations that use a manual MCP configuration, add this entry under <code>mcpServers</code>. On Windows, the Claude Desktop configuration file is usually under <code>%APPDATA%\\Claude\\claude_desktop_config.json</code>. If the client cannot find <code>node</code>, set <code>command</code> to the absolute path of your Node.js executable.

~~~json
{
  "mcpServers": {
    "godot-mcp-assistant": {
      "command": "node",
      "args": ["C:\\path\\to\\godot-mcp-assistant\\index.js"]
    }
  }
}
~~~

Restart the client and check that the server and its tools are available. See Anthropic's [MCP documentation](https://docs.anthropic.com/en/docs/mcp) for client setup information.
## Example request

After connecting the server, ask the assistant something like:

> Create a fully functional top-down player for my Godot 4 project at C:\Games\MyGame. Create scripts/player.gd extending CharacterBody2D with movement using Godot's default ui_left, ui_right, ui_up, and ui_down actions. Then create scenes/player.tscn with a CharacterBody2D root, attach that script, and add a Sprite2D and a CollisionShape2D with a capsule shape. Use existing project assets when appropriate, and tell me if an asset path is missing.

The assistant can analyze the project first, create the script, and then generate a scene that references the script and shape resource. For a new visual asset, provide an existing <code>res://</code> path or ask your assistant to create the asset through another workflow.

## Tool inputs

### create_gdscript

~~~json
{
  "projectPath": "C:/Games/MyGame",
  "scriptPath": "scripts/player.gd",
  "baseClass": "CharacterBody2D",
  "content": "extends CharacterBody2D\n\n@export var speed: float = 300.0\n\nfunc _physics_process(_delta: float) -> void:\n    var direction := Input.get_vector(\"ui_left\", \"ui_right\", \"ui_up\", \"ui_down\")\n    velocity = direction * speed\n    move_and_slide()"
}
~~~

The <code>content</code> field is optional. Without it, the tool generates a starter script for the selected base class. Supplied source gets an <code>extends</code> line if missing, and a conflicting <code>extends</code> declaration is rejected. Existing files are not overwritten unless <code>overwrite</code> is explicitly set to <code>true</code>.

### generate_tscn_scene

Pass a JSON object with a root node, optional external resources, optional sub-resources, and nested children. Node and resource properties use Godot Variant-compatible JSON values. Use <code>$expression</code> only when a property needs a Godot expression such as <code>Vector2(16, 16)</code> or <code>Color(1, 1, 1, 1)</code>. Use <code>$extResource</code> and <code>$subResource</code> to reference declared resources.

~~~json
{
  "projectPath": "C:/Games/MyGame",
  "scenePath": "scenes/player.tscn",
  "scene": {
    "resources": [
      {
        "id": "player_script",
        "type": "Script",
        "path": "res://scripts/player.gd"
      }
    ],
    "subResources": [
      {
        "id": "player_shape",
        "type": "CapsuleShape2D",
        "properties": {
          "radius": 12.0,
          "height": 32.0
        }
      }
    ],
    "root": {
      "name": "Player",
      "type": "CharacterBody2D",
      "properties": {
        "script": {
          "$extResource": "player_script"
        }
      },
      "children": [
        {
          "name": "Sprite2D",
          "type": "Sprite2D"
        },
        {
          "name": "CollisionShape2D",
          "type": "CollisionShape2D",
          "properties": {
            "shape": {
              "$subResource": "player_shape"
            }
          }
        }
      ]
    }
  }
}
~~~

Scene files are created with Godot format version 3. External resource paths should use <code>res://</code>. This tool writes the scene text; it does not import or validate referenced assets in the Godot editor.

### analyze_project_godot

~~~json
{
  "projectPath": "C:/Games/MyGame"
}
~~~

The response includes a <code>sections</code> object. Each setting retains both its original <code>raw</code> text and a best-effort parsed <code>value</code>. Common packed-array constructors are parsed into arrays. Other Godot-specific constructors that are not simple arrays, dictionaries, strings, numbers, booleans, or null remain available as raw strings.

### inject_script_autoload

~~~json
{
  "projectPath": "C:/Games/MyGame",
  "singletonName": "GameState",
  "scriptPath": "res://scripts/game_state.gd"
}
~~~

The GDScript must already exist. If an Autoload with that name points elsewhere, the call returns an error unless <code>replaceExisting</code> is set to <code>true</code>. The tool preserves the other project settings and adds or updates only the named entry in <code>[autoload]</code>.

### Godot editor bridge tools

Install the optional add-on once for each game project:

~~~json
{
  "projectPath": "C:/Games/MyGame"
}
~~~

Pass that input to <code>install_godot_editor_bridge</code>, then open the project in Godot. The editor must remain open for the bridge tools. For example, call <code>godot_editor_status</code> with the same project path, then use:

~~~json
{
  "projectPath": "C:/Games/MyGame",
  "scenePath": "scenes/player.tscn"
}
~~~

Pass this input to <code>godot_open_scene</code> or <code>godot_play_scene</code>. To capture the editor's current 2D viewport, call <code>capture_godot_viewport</code> with <code>{"projectPath":"C:/Games/MyGame","viewport":"2d"}</code>; use <code>"3d"</code> for the 3D editor viewport. The tool attaches the PNG image to its MCP response. Screenshots require a normally running desktop editor, not <code>--headless</code>. Editor controls support Godot 4.0 and newer; viewport capture requires Godot 4.2 or newer.

## File access and safety

- <code>projectPath</code> must be absolute and must contain <code>project.godot</code>.
- Created script and scene paths are relative to the project and cannot escape it.
- Existing files are preserved by default. Set <code>overwrite</code> only when you intentionally want to replace a script or scene.
- The Autoload tool requires an existing script inside the project and only accepts <code>res://</code> paths.
- The file tools do not execute GDScript. The optional editor bridge launches a scene through the open Godot editor. Review generated changes in version control and use Godot to validate project behavior.
- The editor add-on listens only on loopback and accepts a limited set of bridge commands. Install it only in projects you trust.

MCP tools can read or change files accessible to the configured client process. Connect this server only to AI clients and projects you trust.

## Development

~~~sh
npm install
npm start
~~~

This project uses the v1 <code>@modelcontextprotocol/sdk</code> package requested for compatibility with clients that support the standard MCP stdio transport. See the [SDK v1 documentation](https://ts.sdk.modelcontextprotocol.io/) and the [stdio server guide](https://ts.sdk.modelcontextprotocol.io/server).

## License

MIT





