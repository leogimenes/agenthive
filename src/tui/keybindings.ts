export type Panel = 'status' | 'chat' | 'plan' | 'input' | 'transcript' | 'tree';

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

export type HelpTab = {
  name: string;
  entries: Array<{ key: string; desc: string }>;
};

export const HELP_TABS: HelpTab[] = [
  {
    name: 'Global',
    entries: [
      { key: 'q / Ctrl+C', desc: 'Quit TUI' },
      { key: 'Tab', desc: 'Cycle panels' },
      { key: '1 / 2 / 3 / 4', desc: 'Jump to panel (status/chat/plan/input)' },
      { key: 'c', desc: 'Toggle / focus chat panel' },
      { key: 'p', desc: 'Jump to plan panel' },
      { key: 'd', desc: 'Focus dispatch input' },
      { key: 'e', desc: 'Toggle epic tree panel' },
      { key: 't', desc: 'Toggle transcript panel' },
      { key: '?', desc: 'Toggle help overlay' },
    ],
  },
  {
    name: 'Status',
    entries: [
      { key: 'j / k / ↑ / ↓', desc: 'Select agent' },
      { key: 'Enter', desc: 'Open agent detail' },
      { key: 'K', desc: 'Kill selected agent' },
      { key: 'L', desc: 'Launch selected agent' },
      { key: 'Esc', desc: 'Close detail view' },
    ],
  },
  {
    name: 'Chat',
    entries: [
      { key: 'j / k / ↑ / ↓', desc: 'Scroll messages' },
      { key: 'G', desc: 'Jump to bottom' },
      { key: 'g', desc: 'Jump to top' },
      { key: 'f', desc: 'Toggle agent filter' },
      { key: 't', desc: 'Toggle type filter' },
    ],
  },
  {
    name: 'Plan',
    entries: [
      { key: 'j / k / ↑ / ↓', desc: 'Select task' },
      { key: 'Enter', desc: 'Open task detail' },
      { key: 'd', desc: 'Dispatch selected task' },
      { key: 'f', desc: 'Cycle status filter' },
      { key: 'a', desc: 'Cycle agent filter' },
      { key: 'Esc', desc: 'Close detail view' },
    ],
  },
  {
    name: 'Epic Tree',
    entries: [
      { key: 'j / k / ↑ / ↓', desc: 'Navigate nodes' },
      { key: 'Space', desc: 'Expand / collapse epic or story' },
      { key: 'Enter', desc: 'Open epic dispatch view' },
      { key: 'G', desc: 'Jump to last node' },
      { key: 'Esc', desc: 'Exit tree panel' },
    ],
  },
  {
    name: 'Dispatch',
    entries: [
      { key: 's', desc: 'Start: dispatch all ready tasks' },
      { key: 'p', desc: 'Pause / resume auto-dispatch' },
      { key: 'd', desc: 'Deliver: trigger completion workflow' },
      { key: 'y / n', desc: 'Confirm / cancel action' },
      { key: 'Esc', desc: 'Back to epic tree' },
    ],
  },
  {
    name: 'Transcript',
    entries: [
      { key: 'h / l', desc: 'Previous / next agent' },
      { key: 'j / k / ↑ / ↓', desc: 'Scroll events' },
      { key: 'G', desc: 'Jump to bottom' },
      { key: 'Esc', desc: 'Exit transcript panel' },
    ],
  },
  {
    name: 'Input',
    entries: [
      { key: 'Enter', desc: 'Send message' },
      { key: 'Tab', desc: 'Autocomplete agent name' },
      { key: '↑ / ↓', desc: 'Recall message history' },
      { key: 'Esc', desc: 'Cancel / return to panels' },
    ],
  },
];
