export type Panel = 'status' | 'chat' | 'input';

export type Action =
  | { type: 'quit' }
  | { type: 'cycle_panel' }
  | { type: 'focus_panel'; panel: Panel }
  | { type: 'focus_input' }
  | { type: 'toggle_help' }
  | { type: 'select_up' }
  | { type: 'select_down' }
  | { type: 'scroll_top' }
  | { type: 'scroll_bottom' }
  | { type: 'enter' }
  | { type: 'escape' }
  | { type: 'toggle_filter' }
  | { type: 'toggle_type_filter' }
  | { type: 'search' }
  | { type: 'kill_agent' }
  | { type: 'launch_agent' };

export const HELP_ENTRIES = [
  { key: 'q / Ctrl+C', desc: 'Quit TUI' },
  { key: 'Tab', desc: 'Cycle panels' },
  { key: '1 / 2 / 3', desc: 'Jump to panel (status/chat/input)' },
  { key: 'd', desc: 'Focus dispatch input' },
  { key: '?', desc: 'Toggle help overlay' },
  { key: '', desc: '' },
  { key: '── Status ──', desc: '' },
  { key: 'j / k / ↑ / ↓', desc: 'Select agent' },
  { key: 'Enter', desc: 'Open agent detail' },
  { key: 'K', desc: 'Kill selected agent' },
  { key: 'L', desc: 'Launch selected agent' },
  { key: '', desc: '' },
  { key: '── Chat ──', desc: '' },
  { key: 'j / k / ↑ / ↓', desc: 'Scroll messages' },
  { key: 'G', desc: 'Jump to bottom' },
  { key: 'g', desc: 'Jump to top' },
  { key: 'f', desc: 'Toggle agent filter' },
  { key: 't', desc: 'Toggle type filter' },
  { key: '', desc: '' },
  { key: '── Input ──', desc: '' },
  { key: 'Enter', desc: 'Send message' },
  { key: 'Tab', desc: 'Autocomplete agent name' },
  { key: 'Esc', desc: 'Cancel / return to panels' },
  { key: '↑', desc: 'Recall previous message' },
];
