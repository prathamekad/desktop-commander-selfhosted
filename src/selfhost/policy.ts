import path from 'path';

const FILE_TOOL_PATHS: Record<string, string[]> = {
  read_file: ['path'],
  read_multiple_files: ['paths'],
  write_file: ['path'],
  write_pdf: ['path', 'outputPath'],
  create_directory: ['path'],
  list_directory: ['path'],
  move_file: ['source', 'destination'],
  start_search: ['path'],
  get_file_info: ['path'],
  edit_block: ['file_path']
};

const HIDDEN_REMOTE_TOOLS = new Set([
  'set_config_value',
  'give_feedback_to_desktop_commander',
  'get_prompts',
  'list_processes',
  'list_sessions',
  'get_recent_tool_calls'
]);

const PROCESS_PID_TOOLS = new Set([
  'read_process_output',
  'interact_with_process',
  'kill_process',
  'force_terminate'
]);

const READ_ONLY_PATH_TOOLS = new Set([
  'read_file',
  'read_multiple_files',
  'list_directory',
  'start_search',
  'get_file_info'
]);

const DENIED_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|[\\/\s'"\x60])\.\.([\\/]|$)/i, reason: 'parent-directory traversal' },
  { pattern: /(^|\s)~[\\/]/, reason: 'home-directory expansion' },
  { pattern: /\\\\[^\s]+\\[^\s]+/i, reason: 'UNC path access' },
  { pattern: /\b(?:invoke-expression|iex)\b/i, reason: 'dynamic PowerShell evaluation' },
  { pattern: /\b(?:registry::|hklm:|hkcu:|cert:)\b/i, reason: 'non-filesystem PowerShell provider' },
  {
    pattern: /\$env:(?:userprofile|homedrive|homepath|windir|systemroot|appdata|localappdata|programdata|programfiles|temp|tmp)\b/i,
    reason: 'environment-based path escape'
  },
  {
    pattern: /%(?:userprofile|homedrive|homepath|windir|systemroot|appdata|localappdata|programdata|programfiles|temp|tmp)%/i,
    reason: 'environment-based path escape'
  },
  {
    pattern: /\b(?:shutdown(?:\.exe)?|reboot|halt|poweroff|set-itemproperty|new-itemproperty|remove-itemproperty|stop-computer|restart-computer|set-service|stop-service|start-service|new-service|set-executionpolicy|add-mppreference|set-mppreference|remove-mppreference|new-netfirewallrule|remove-netfirewallrule|set-netfirewallprofile|disable-netadapter|enable-netadapter)\b/i,
    reason: 'system-management command'
  }
];

export class RemotePolicyError extends Error {
  constructor(
    message: string,
    public readonly reason: string
  ) {
    super(message);
  }
}

export function isRemoteToolVisible(toolName: string): boolean {
  return !HIDDEN_REMOTE_TOOLS.has(toolName);
}

export function isPidControlledTool(toolName: string): boolean {
  return PROCESS_PID_TOOLS.has(toolName);
}
function canonicalWindowsPath(value: string): string {
  const expanded = value.replace(/\//g, '\\');
  return path.win32.normalize(expanded).replace(/[\\]+$/, '').toLowerCase();
}

export function pathAllowed(value: string, roots: string[]): boolean {
  if (!value || roots.length === 0) return false;
  if (/^https?:\/\//i.test(value)) return false;

  const candidate = canonicalWindowsPath(value);
  if (!path.win32.isAbsolute(candidate)) return false;

  return roots.some((root) => {
    const allowed = canonicalWindowsPath(root);
    return candidate === allowed || candidate.startsWith(allowed + '\\');
  });
}

function collectToolPaths(toolName: string, args: Record<string, unknown>): string[] {
  const keys = FILE_TOOL_PATHS[toolName] ?? [];
  const paths: string[] = [];

  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value) paths.push(value);
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item) paths.push(item);
    }
  }

  if (toolName === 'write_pdf' && Array.isArray(args.content)) {
    for (const operation of args.content) {
      if (!operation || typeof operation !== 'object') continue;
      const source = (operation as Record<string, unknown>).sourcePdfPath;
      if (typeof source === 'string' && source) paths.push(source);
    }
  }

  return paths;
}

function extractAbsoluteWindowsPaths(command: string): string[] {
  const matches = command.match(/[A-Za-z]:[\\/][^\r\n;"'\x60|<>]*/g) ?? [];
  return matches
    .map((match) => match.trim())
    .filter(Boolean);
}

export function assertRemoteToolPolicy(
  toolName: string,
  args: Record<string, unknown>,
  allowedRoots: string[],
  readOnlyRoots: string[] = []
): void {
  if (!isRemoteToolVisible(toolName)) {
    throw new RemotePolicyError(
      `Tool '${toolName}' is disabled for remote connectors.`,
      'tool_not_exposed'
    );
  }

  if (toolName === 'read_file' && args.isUrl === true) {
    throw new RemotePolicyError(
      'Remote URL fetching through Home is disabled; use the model/web client for internet access.',
      'remote_url_fetch_disabled'
    );
  }

  const fileRoots = READ_ONLY_PATH_TOOLS.has(toolName)
    ? [...allowedRoots, ...readOnlyRoots]
    : allowedRoots;

  for (const requestedPath of collectToolPaths(toolName, args)) {
    if (!pathAllowed(requestedPath, fileRoots)) {
      const message = READ_ONLY_PATH_TOOLS.has(toolName)
        ? `Path is outside the approved remote read roots: ${requestedPath}`
        : `Path is outside the approved remote writable roots: ${requestedPath}`;
      throw new RemotePolicyError(message, 'path_outside_allowed_roots');
    }
  }

  if (toolName === 'start_process') {
    const command = typeof args.command === 'string' ? args.command : '';
    if (!command.trim()) {
      throw new RemotePolicyError('start_process requires a non-empty command.', 'invalid_command');
    }
    if (command.trim().toLowerCase() === 'node:local') {
      throw new RemotePolicyError(
        'node:local is disabled remotely because it bypasses workspace path controls.',
        'node_local_disabled'
      );
    }
    if (typeof args.shell === 'string' && args.shell.trim()) {
      throw new RemotePolicyError(
        'Custom shell selection is disabled remotely; the configured default shell is used.',
        'custom_shell_disabled'
      );
    }

    for (const { pattern, reason } of DENIED_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        throw new RemotePolicyError(
          `Remote process command rejected by workspace policy: ${reason}.`,
          reason
        );
      }
    }

    for (const absolutePath of extractAbsoluteWindowsPaths(command)) {
      if (!pathAllowed(absolutePath, allowedRoots)) {
        throw new RemotePolicyError(
          `Remote process command references a path outside approved roots: ${absolutePath}`,
          'command_path_outside_allowed_roots'
        );
      }
    }
  }
}

export function preferredWorkingRoot(allowedRoots: string[]): string | null {
  return allowedRoots[0] ?? null;
}

export function wrapPowerShellCommand(command: string, allowedRoots: string[]): string {
  const root = preferredWorkingRoot(allowedRoots);
  if (!root) return command;
  const escaped = root.replace(/'/g, "''");
  return `Set-Location -LiteralPath '${escaped}'; ${command}`;
}
