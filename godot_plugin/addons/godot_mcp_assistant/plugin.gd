@tool
extends EditorPlugin

const DEFAULT_PORT := 47531
const MAX_REQUEST_BYTES := 65536
const MAX_SCREENSHOT_DIMENSION := 8192
const MAX_SCREENSHOT_PIXELS := 33554432

var _server := TCPServer.new()
var _port := DEFAULT_PORT
var _peers: Array[StreamPeerTCP] = []
var _buffers: Array[String] = []


func _enter_tree() -> void:
	_port = int(ProjectSettings.get_setting("godot_mcp_assistant/bridge_port", DEFAULT_PORT))
	var error := _server.listen(_port, "127.0.0.1")
	if error != OK:
		push_error("Godot MCP Assistant could not listen on 127.0.0.1:%d (error %d)." % [_port, error])
		return
	set_process(true)
	print("Godot MCP Assistant bridge listening on 127.0.0.1:%d." % _port)


func _exit_tree() -> void:
	set_process(false)
	_server.stop()
	for peer in _peers:
		peer.disconnect_from_host()
	_peers.clear()
	_buffers.clear()


func _process(_delta: float) -> void:
	while _server.is_connection_available():
		_peers.append(_server.take_connection())
		_buffers.append("")

	for index in range(_peers.size() - 1, -1, -1):
		var peer := _peers[index]
		peer.poll()
		if peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			_drop_peer(index)
			continue

		var available := peer.get_available_bytes()
		if available <= 0:
			continue

		var received: Array = peer.get_data(available)
		if received[0] != OK:
			_drop_peer(index)
			continue

		_buffers[index] += (received[1] as PackedByteArray).get_string_from_utf8()
		if _buffers[index].to_utf8_buffer().size() > MAX_REQUEST_BYTES:
			_send_response(peer, "", false, {}, "Request exceeds the 64 KiB limit.")
			_drop_peer(index)
			continue

		var newline_index := _buffers[index].find("\n")
		while newline_index >= 0:
			var line := _buffers[index].substr(0, newline_index).strip_edges()
			_buffers[index] = _buffers[index].substr(newline_index + 1)
			if not line.is_empty():
				_handle_line(peer, line)
			newline_index = _buffers[index].find("\n")


func _drop_peer(index: int) -> void:
	_peers[index].disconnect_from_host()
	_peers.remove_at(index)
	_buffers.remove_at(index)


func _handle_line(peer: StreamPeerTCP, line: String) -> void:
	var request: Variant = JSON.parse_string(line)
	if typeof(request) != TYPE_DICTIONARY:
		_send_response(peer, "", false, {}, "Request must be a JSON object.")
		return

	var request_id := str(request.get("id", ""))
	var result: Dictionary = await _dispatch_request(request)
	if result.has("error"):
		_send_response(peer, request_id, false, {}, str(result.error))
	else:
		_send_response(peer, request_id, true, result, "")


func _dispatch_request(request: Dictionary) -> Dictionary:
	var command := str(request.get("command", ""))
	match command:
		"ping":
			var scene_root := EditorInterface.get_edited_scene_root()
			return {
				"project_path": ProjectSettings.globalize_path("res://").trim_suffix("/").trim_suffix("\\"),
				"godot_version": Engine.get_version_info().get("string", "unknown"),
				"current_scene": scene_root.scene_file_path if scene_root != null else "",
				"is_playing": EditorInterface.is_playing_scene(),
				"bridge_port": _port
			}
		"open_scene":
			var scene_path := str(request.get("scene_path", ""))
			if not _is_safe_resource_path(scene_path):
				return {"error": "scene_path must be a safe res:// path inside the project."}
			EditorInterface.open_scene_from_path(scene_path)
			return {"opened_scene": scene_path}
		"play_scene":
			var scene_path := str(request.get("scene_path", ""))
			if scene_path.is_empty():
				if EditorInterface.get_edited_scene_root() == null:
					return {"error": "There is no open scene to play."}
				EditorInterface.play_current_scene()
			else:
				if not _is_safe_resource_path(scene_path):
					return {"error": "scene_path must be a safe res:// path inside the project."}
				EditorInterface.play_custom_scene(scene_path)
			return {"started": true, "scene_path": scene_path}
		"stop_scene":
			if EditorInterface.is_playing_scene():
				EditorInterface.stop_playing_scene()
			return {"stopped": true}
		"capture_viewport":
			return await _capture_viewport(request)
		_:
			return {"error": "Unsupported bridge command: " + command}


func _capture_viewport(request: Dictionary) -> Dictionary:
	if not EditorInterface.has_method("get_editor_viewport_2d"):
		return {"error": "Viewport capture requires Godot 4.2 or newer. Editor control tools work on Godot 4.0+."}
	if DisplayServer.get_name() == "headless":
		return {"error": "Viewport screenshots require the Godot editor running with its normal display, not --headless."}

	var viewport_name := str(request.get("viewport", "2d"))
	var output_path := str(request.get("output_path", ""))
	if viewport_name != "2d" and viewport_name != "3d":
		return {"error": "viewport must be either 2d or 3d."}
	if not _is_safe_screenshot_path(output_path):
		return {"error": "output_path must be a godot-mcp-assistant PNG inside the system temp directory."}

	var viewport: Viewport
	if viewport_name == "2d":
		viewport = EditorInterface.call("get_editor_viewport_2d")
	else:
		viewport = EditorInterface.call("get_editor_viewport_3d", 0)
	if viewport == null:
		return {"error": "Godot did not provide the requested editor viewport."}

	await RenderingServer.frame_post_draw
	var image := viewport.get_texture().get_image()
	if image == null or image.is_empty():
		return {"error": "The editor viewport did not produce an image."}
	if image.get_width() > MAX_SCREENSHOT_DIMENSION or image.get_height() > MAX_SCREENSHOT_DIMENSION:
		return {"error": "Viewport dimensions exceed the 8192 pixel safety limit."}
	if image.get_width() * image.get_height() > MAX_SCREENSHOT_PIXELS:
		return {"error": "Viewport image exceeds the 33.5 megapixel safety limit."}

	var save_error := image.save_png(output_path)
	if save_error != OK:
		return {"error": "Could not save the viewport PNG (error %d)." % save_error}
	return {
		"output_path": output_path,
		"viewport": viewport_name,
		"width": image.get_width(),
		"height": image.get_height()
	}


func _is_safe_resource_path(resource_path: String) -> bool:
	if not resource_path.begins_with("res://") or resource_path.contains("\\") or resource_path.contains("\n") or resource_path.contains("\r"):
		return false
	for segment in resource_path.substr(6).split("/"):
		if segment == ".." or segment == ".":
			return false
	return resource_path.ends_with(".tscn") or resource_path.ends_with(".scn")


func _is_safe_screenshot_path(output_path: String) -> bool:
	var normalized_path := output_path.replace("\\", "/").simplify_path()
	var temp_directory := OS.get_temp_dir().replace("\\", "/").simplify_path().trim_suffix("/")
	var comparable_path := normalized_path
	var comparable_temp := temp_directory
	if OS.get_name() == "Windows":
		comparable_path = comparable_path.to_lower()
		comparable_temp = comparable_temp.to_lower()
	var filename := normalized_path.get_file()
	return comparable_path.begins_with(comparable_temp + "/") \
		and filename.begins_with("godot-mcp-assistant-") \
		and filename.ends_with(".png")


func _send_response(peer: StreamPeerTCP, request_id: String, ok: bool, result: Dictionary, error_message: String) -> void:
	var response := {
		"id": request_id,
		"ok": ok
	}
	if ok:
		response["result"] = result
	else:
		response["error"] = error_message
	peer.put_data((JSON.stringify(response) + "\n").to_utf8_buffer())
