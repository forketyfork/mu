// This classic script runs in the head, before styles and body, so saved tokens are in place at first paint.
(() => {
  const palette = {
    ink: ['#e7eef9', 'text'],
    muted: ['#a0afc6', 'text'],
    subtle: ['#8190aa', 'text'],
    line: ['#25334b', 'edge'],
    accent: ['#75f6db', 'text'],
    'accent-soft': ['#163d3b', 'surface'],
    surface: ['#101927', 'surface'],
    canvas: ['#090f1b', 'surface'],
    green: ['#84f5b5', 'text'],
    amber: ['#ffce82', 'text'],
    red: ['#ff9aab', 'text'],
    'button-focus-visible-edge': ['#8e9bff', 'fill'],
    'rail-surface': ['#0c1220', 'surface'],
    'rail-edge': ['#23324a', 'edge'],
    'brand-glow': ['#67efd248', 'glow'],
    'brand-dot-surface': ['#9c87ff', 'fill'],
    'brand-dot-glow': ['#9c87ff90', 'glow'],
    'rail-link-ink': ['#90a0bc', 'text'],
    'rail-link-hover-surface': ['#17243a', 'surface'],
    'rail-link-selected-surface': ['#16302f', 'surface'],
    'rail-link-selected-edge': ['#326256', 'edge'],
    'rail-link-selected-glow': ['#65e9c60a', 'glow'],
    'rail-link-selected-glow-2': ['#75f6db06', 'glow'],
    'rail-badge-surface': ['#b3a0ff', 'fill'],
    'rail-badge-ink': ['#211a37', 'inverse'],
    'topbar-surface': ['#0d1523', 'surface'],
    'breadcrumb-ink': ['#91a2bc', 'text'],
    'breadcrumb-strong-ink': ['#d3def0', 'text'],
    'workspace-icon-edge': ['#3c4765', 'edge'],
    'workspace-icon-ink': ['#c5b6ff', 'text'],
    'workspace-icon-surface': ['#24223c', 'surface'],
    'breadcrumb-slash-ink': ['#4a5e79', 'text'],
    'archive-toggle-ink': ['#a1b0c7', 'text'],
    'archive-toggle-hover-ink': ['#d5e0f3', 'text'],
    'archive-count-surface': ['#1f2c42', 'surface'],
    'archive-count-edge': ['#384862', 'edge'],
    'archive-count-ink': ['#a8b8d3', 'text'],
    'connection-badge-connected-ink': ['#8bdcc2', 'text'],
    'connection-badge-disconnected-ink': ['#edbe80', 'text'],
    'user-avatar-ink': ['#b6a8ee', 'text'],
    'user-avatar-surface': ['#2a243d', 'surface'],
    'user-avatar-edge': ['#504264', 'edge'],
    'main-pane-surface': ['#274a5924', 'glow'],
    'main-pane-surface-2': ['#42386a16', 'glow'],
    'main-pane-surface-3': ['#2c3b531a', 'glow'],
    'main-pane-surface-4': ['#0b111f', 'surface'],
    'eyebrow-ink': ['#91bfc4', 'text'],
    'heading-dot-glow': ['#75f6db50', 'glow'],
    'page-subtitle-ink': ['#9baac0', 'text'],
    'button-primary-ink': ['#0a2423', 'inverse'],
    'button-primary-edge': ['#8bffe5', 'fill'],
    'button-primary-glow': ['#75f6db16', 'glow'],
    'button-primary-hover-surface': ['#a1ffe9', 'fill'],
    'button-primary-hover-glow': ['#75f6db30', 'glow'],
    'button-secondary-ink': ['#c1cce1', 'text'],
    'button-secondary-surface': ['#182237', 'surface'],
    'button-secondary-edge': ['#35435c', 'edge'],
    'button-secondary-hover-ink': ['#e0e8f7', 'text'],
    'button-secondary-hover-edge': ['#7b8db4', 'fill'],
    'button-secondary-hover-surface': ['#202c42', 'surface'],
    'metric-edge': ['#2a3851', 'edge'],
    'metric-surface': ['#172235', 'surface'],
    'metric-surface-2': ['#111b2b', 'surface'],
    'metric-glow': ['#00000012', 'glow'],
    'metric-after-surface': ['#5a739d', 'surface'],
    'metric-label-ink': ['#c0cce0', 'text'],
    'agents-icon-surface': ['#302d50', 'surface'],
    'agents-icon-ink': ['#b8a8ff', 'text'],
    'working-icon-surface': ['#1b3c37', 'surface'],
    'working-icon-ink': ['#87e4c7', 'text'],
    'attention-icon-surface': ['#3a3227', 'surface'],
    'attention-icon-ink': ['#e8c488', 'text'],
    'metric-value-ink': ['#eaf3ff', 'text'],
    'metric-list-task-ref-ink': ['#d1c5ff', 'text'],
    'metric-detail-ink': ['#96a5bd', 'text'],
    'live-label-ink': ['#a3b2ca', 'text'],
    'live-label-span-surface': ['#7fcdb1', 'fill'],
    'live-label-span-glow': ['#7fcdb133', 'glow'],
    'live-label-offline-span-surface': ['#bd9a65', 'fill'],
    'team-toolbar-edge': ['#2a374f', 'edge'],
    'filter-ink': ['#9aaac4', 'text'],
    'filter-active-surface': ['#193734', 'surface'],
    'filter-active-edge': ['#355d55', 'edge'],
    'filter-active-ink': ['#a0efdb', 'text'],
    'filter-hover-surface': ['#1d2b41', 'surface'],
    'search-ink': ['#8e9fb9', 'text'],
    'search-input-ink': ['#c3cee4', 'text'],
    'search-input-placeholder-ink': ['#8797b2', 'text'],
    'agent-card-surface': ['#172236', 'surface'],
    'agent-card-surface-2': ['#101a2b', 'surface'],
    'agent-card-edge': ['#2d3e58', 'edge'],
    'agent-card-has-status-working-edge': ['#42685e', 'edge'],
    'agent-card-has-status-working-glow': ['#72f6d508', 'glow'],
    'agent-card-has-status-error-edge': ['#654452', 'edge'],
    'agent-avatar-ink': ['#94d8e3', 'text'],
    'agent-avatar-surface': ['#203d4b', 'surface'],
    'agent-avatar-edge': ['#3c6577', 'edge'],
    'agent-avatar-lead-ink': ['#cbb6ff', 'text'],
    'agent-avatar-lead-surface': ['#352c51', 'surface'],
    'agent-avatar-lead-edge': ['#5f4b85', 'edge'],
    'agent-avatar-lead-glow': ['#b6a2ff10', 'glow'],
    'agent-name-ink': ['#e7effe', 'text'],
    'agent-role-ink': ['#9cabc5', 'text'],
    'status-idle-ink': ['#bfd0ed', 'text'],
    'status-idle-surface': ['#25344d', 'surface'],
    'status-idle-edge': ['#3d506d', 'edge'],
    'status-working-ink': ['#9af4c5', 'text'],
    'status-working-surface': ['#1b3c31', 'surface'],
    'status-working-edge': ['#326048', 'edge'],
    'status-blocked-ink': ['#f0cb8e', 'text'],
    'status-blocked-surface': ['#3e3426', 'surface'],
    'status-blocked-edge': ['#67553a', 'edge'],
    'status-done-ink': ['#bcbdff', 'text'],
    'status-done-surface': ['#2e2e50', 'surface'],
    'status-done-edge': ['#4d4d7a', 'edge'],
    'status-stopped-ink': ['#a3aec4', 'text'],
    'status-stopped-surface': ['#232d40', 'surface'],
    'status-stopped-edge': ['#3b465b', 'edge'],
    'status-error-ink': ['#ffb1be', 'text'],
    'status-error-surface': ['#482d3b', 'surface'],
    'status-error-edge': ['#704453', 'edge'],
    'agent-task-details-edge': ['#293950', 'edge'],
    'agent-task-details-summary-ink': ['#c4d2ec', 'text'],
    'agent-task-ink': ['#bcc9df', 'text'],
    'agent-error-ink': ['#ffc0ca', 'text'],
    'agent-error-surface': ['#3a2533', 'surface'],
    'agent-error-edge': ['#60404d', 'edge'],
    'agent-directory-ink': ['#93a6c4', 'text'],
    'runtime-indicator-edge': ['#2a3b54', 'edge'],
    'runtime-indicator-surface': ['#111c2e', 'surface'],
    'runtime-indicator-ink': ['#c3d0e6', 'text'],
    'runtime-absent-ink': ['#7f8fab', 'text'],
    'runtime-partial-ink': ['#a9b7cf', 'text'],
    'context-meter-surface': ['#22324a', 'surface'],
    'context-meter-fill-surface': ['#72d6c2', 'fill'],
    'context-meter-fill-high-surface': ['#f0b46f', 'fill'],
    'agent-card-footer-surface': ['#0c142329', 'glow'],
    'agent-card-footer-ink': ['#9bacc9', 'text'],
    'icon-action-ink': ['#9cdddf', 'text'],
    'icon-action-hover-not-disabled-surface': ['#293d57', 'surface'],
    'icon-action-hover-not-disabled-ink': ['#d0fffa', 'text'],
    'icon-action-stop-ink': ['#b0adc5', 'text'],
    'empty-state-edge': ['#3c4d6c', 'edge'],
    'empty-state-surface': ['#111d2cbd', 'glow'],
    'empty-node-ink': ['#9bf1e2', 'text'],
    'empty-node-surface': ['#1c3d3f', 'surface'],
    'empty-node-edge': ['#3d7775', 'edge'],
    'empty-node-glow': ['#75f6db12', 'glow'],
    'empty-node-small-ink': ['#b6a1e9', 'text'],
    'empty-node-small-surface': ['#25283f', 'surface'],
    'empty-node-small-edge': ['#45415e', 'edge'],
    'empty-line-edge': ['#4c627d', 'edge'],
    'empty-state-h3-ink': ['#d1dff3', 'text'],
    'empty-state-p-ink': ['#9cacc6', 'text'],
    'workspace-footer-ink': ['#8e9db5', 'text'],
    'footer-dot-surface': ['#92bcbb', 'fill'],
    'waiting-card-edge': ['#3c4766', 'edge'],
    'waiting-card-surface': ['#1d243a', 'surface'],
    'waiting-card-surface-2': ['#111b2c', 'surface'],
    'waiting-card-hover-edge': ['#5a6a94', 'edge'],
    'waiting-task-edge': ['#344360', 'edge'],
    'waiting-task-hover-surface': ['#ffffff0d', 'glow'],
    'activity-archive-toggle-aria-pressed-true-edge': ['#3f7f78', 'edge'],
    'activity-lane-edge': ['#2a3753', 'edge'],
    'activity-lane-surface': ['#0d1524', 'surface'],
    'lane-cards-drop-target-surface': ['#ffffff08', 'glow'],
    'activity-delete-ink': ['#6f7f9c', 'text'],
    'activity-card-hover-activity-delete-ink': ['#a9b6cd', 'text'],
    'text-button-danger-hover-ink': ['#ffc2cd', 'text'],
    'activity-card-hover-activity-check-not-hover-ink': ['#8d9bbb', 'text'],
    'activity-input-edge': ['#5a7397', 'edge'],
    'activity-input-surface': ['#0a1220', 'surface'],
    'task-square-archived-surface': ['#6b7a96', 'surface'],
    'task-square-tip-edge': ['#476181', 'edge'],
    'task-square-tip-surface': ['#19253a', 'surface'],
    'task-square-tip-glow': ['#00000070', 'glow'],
    'archive-item-edge': ['#1f2b44', 'edge'],
    'archive-text-glow': ['#55637f', 'edge'],
    'task-notice-ink': ['#a1b4cf', 'text'],
    'task-card-revealed-glow': ['#75f6db55', 'glow'],
    'task-status-edge': ['#4b5681', 'edge'],
    'task-status-surface': ['#2a2e47', 'surface'],
    'task-status-ink': ['#c1b6f5', 'text'],
    'task-status-ready-ink': ['#ffdda6', 'text'],
    'task-status-ready-surface': ['#3c332b', 'surface'],
    'task-status-ready-edge': ['#796446', 'edge'],
    'task-status-verified-ink': ['#b6f5d2', 'text'],
    'task-status-verified-surface': ['#213e36', 'surface'],
    'task-status-verified-edge': ['#46735f', 'edge'],
    'task-result-open-ink': ['#8debd9', 'text'],
    'task-assignment-ink': ['#a2b3d0', 'text'],
    'task-worker-edge': ['#435574', 'edge'],
    'task-worker-surface': ['#182b40', 'surface'],
    'task-worker-ink': ['#b8d5ed', 'text'],
    'task-card-footer-surface': ['#101c2c', 'surface'],
    'task-retirement-ink': ['#9fb5cf', 'text'],
    'task-notification-error-ink': ['#ffb6c4', 'text'],
    'markdown-body-ink': ['#b9c9e2', 'text'],
    'markdown-body-h1-ink': ['#dce8f9', 'text'],
    'markdown-body-a-hover-ink': ['#c5fff3', 'text'],
    'markdown-body-strong-ink': ['#deebfd', 'text'],
    'markdown-body-code-surface': ['#24334b', 'surface'],
    'markdown-body-task-ref-hover-ink': ['#ece6ff', 'text'],
    'markdown-body-pre-edge': ['#344b67', 'edge'],
    'markdown-body-pre-surface': ['#091422', 'surface'],
    'markdown-body-pre-code-ink': ['#c9dff5', 'text'],
    'markdown-body-blockquote-edge': ['#6f9bc1', 'fill'],
    'markdown-body-blockquote-ink': ['#a7bdd7', 'text'],
    'markdown-body-th-edge': ['#3b4e68', 'edge'],
    'markdown-body-th-ink': ['#d8e6f7', 'text'],
    'markdown-body-th-surface': ['#1c3045', 'surface'],
    'markdown-body-hr-edge': ['#3e536d', 'edge'],
    'chat-pane-surface': ['#0e1625', 'surface'],
    'chat-header-edge': ['#26354d', 'edge'],
    'chat-header-surface': ['#192439', 'surface'],
    'chat-header-surface-2': ['#111a2b', 'surface'],
    'conversation-browser-summary-edge': ['#3a4d6c', 'edge'],
    'conversation-browser-summary-surface': ['#151f32', 'surface'],
    'conversation-browser-summary-ink': ['#c4d6ee', 'text'],
    'conversation-browser-summary-hover-surface': ['#1b2a42', 'surface'],
    'conversation-list-glow': ['#374c68', 'edge'],
    'conversation-group-ink': ['#91a7c7', 'text'],
    'conversation-option-ink': ['#b7c9e6', 'text'],
    'conversation-option-hover-surface': ['#1b2e44', 'surface'],
    'conversation-option-selected-ink': ['#b2ffe8', 'text'],
    'conversation-option-selected-surface': ['#1a3b37', 'surface'],
    'conversation-option-selected-edge': ['#35685a', 'edge'],
    'picker-option-selected-active-surface': ['#1f4743', 'surface'],
    'conversation-archive-toggle-edge': ['#2c3d57', 'edge'],
    'channel-hash-ink': ['#7dcfc7', 'text'],
    'chat-count-ink': ['#a3b5ce', 'text'],
    'chat-count-surface': ['#202d43', 'surface'],
    'chat-count-edge': ['#364760', 'edge'],
    'chat-header-conversation-members-ink': ['#a4b7d4', 'text'],
    'chat-empty-icon-surface': ['#202d44', 'surface'],
    'chat-empty-icon-edge': ['#384c69', 'edge'],
    'chat-empty-icon-ink': ['#9bafd7', 'text'],
    'chat-empty-h3-ink': ['#c0cce3', 'text'],
    'chat-empty-p-ink': ['#94a5bf', 'text'],
    'message-avatar-surface': ['#233949', 'surface'],
    'message-avatar-edge': ['#365669', 'edge'],
    'message-avatar-ink': ['#a2d4e0', 'text'],
    'message-avatar-user-surface': ['#322c48', 'surface'],
    'message-avatar-user-edge': ['#514367', 'edge'],
    'message-avatar-user-ink': ['#cdb5f5', 'text'],
    'message-avatar-system-surface': ['#2b3447', 'surface'],
    'message-avatar-system-edge': ['#414f69', 'edge'],
    'message-avatar-system-ink': ['#bac6df', 'text'],
    'message-sender-ink': ['#d1e0f5', 'text'],
    'message-time-ink': ['#869ab8', 'text'],
    'message-id-ink': ['#5f7391', 'text'],
    'message-new-message-main-surface': ['#75f6db0d', 'glow'],
    'message-revealed-message-main-surface': ['#75f6db14', 'glow'],
    'message-ref-ink': ['#9bf1dc', 'text'],
    'message-ref-edge': ['#5aa89a', 'edge'],
    'message-ref-hover-surface': ['#1b3b39', 'surface'],
    'message-role-edge': ['#625488', 'edge'],
    'message-role-ink': ['#c4b5ef', 'text'],
    'message-role-surface': ['#312843', 'surface'],
    'message-day-ink': ['#8499b9', 'text'],
    'message-day-before-surface': ['#2c3d55', 'surface'],
    'composer-box-focus-within-edge': ['#72c6ba', 'fill'],
    'composer-box-focus-within-glow': ['#75f6db09', 'glow'],
    'composer-box-focus-within-glow-2': ['#75f6db08', 'glow'],
    'activity-ticker-ink': ['#95a9c2', 'text'],
    'activity-agent-ink': ['#91c6bb', 'text'],
    'composer-box-textarea-ink': ['#d2e0f3', 'text'],
    'composer-box-textarea-placeholder-ink': ['#8297b6', 'text'],
    'mention-button-ink': ['#a3b8db', 'text'],
    'mention-button-hover-surface': ['#243750', 'surface'],
    'mention-button-hover-edge': ['#405573', 'edge'],
    'composer-identity-ink': ['#92a4bf', 'text'],
    'composer-identity-strong-ink': ['#b9c9e3', 'text'],
    'send-button-edge': ['#a1ffe7', 'fill'],
    'send-button-surface': ['#7af1d9', 'fill'],
    'send-button-ink': ['#102b2b', 'inverse'],
    'send-button-glow': ['#75f6db10', 'glow'],
    'send-button-hover-surface': ['#a2ffe9', 'fill'],
    'composer-hint-ink': ['#8d9fbb', 'text'],
    'kbd-ink': ['#a8bbd5', 'text'],
    'composer-error-ink': ['#ffb0bf', 'text'],
    'mention-menu-glow': ['#00000065', 'glow'],
    'mention-option-ink': ['#b4e6e2', 'text'],
    'mention-option-hover-surface': ['#2a3c53', 'surface'],
    'mention-option-span-ink': ['#a5b8d3', 'text'],
    'new-messages-edge': ['#537d79', 'edge'],
    'new-messages-ink': ['#bef8e9', 'text'],
    'new-messages-surface': ['#244c45', 'surface'],
    'new-messages-glow': ['#00000030', 'glow'],
    'error-notice-surface': ['#3c2634', 'surface'],
    'error-notice-edge': ['#714757', 'edge'],
    'error-notice-ink': ['#ffbdc7', 'text'],
    'transport-notice-surface': ['#3d3326', 'surface'],
    'transport-notice-edge': ['#705c38', 'edge'],
    'transport-notice-ink': ['#f4d09b', 'text'],
    'agent-dialog-edge': ['#45617a', 'edge'],
    'agent-dialog-surface': ['#19263a', 'surface'],
    'agent-dialog-surface-2': ['#101a2c', 'surface'],
    'agent-dialog-glow': ['#000000a0', 'glow'],
    'agent-dialog-glow-2': ['#75f6db0a', 'glow'],
    'agent-dialog-backdrop-surface': ['#050912bf', 'glow'],
    'icon-button-ink': ['#a4b8d8', 'text'],
    'agent-dialog-label-ink': ['#c1d0e7', 'text'],
    'agent-dialog-input-edge': ['#3d526e', 'edge'],
    'agent-dialog-input-surface': ['#0f1b2d', 'surface'],
    'agent-dialog-input-ink': ['#d1e0f4', 'text'],
    'agent-dialog-input-placeholder-ink': ['#8096b5', 'text'],
    'agent-dialog-input-read-only-ink': ['#9eb4d1', 'text'],
    'agent-dialog-input-read-only-surface': ['#19273b', 'surface'],
    'field-hint-ink': ['#8fa6c3', 'text'],
    'dialog-actions-edge': ['#2c425d', 'edge'],
    'toast-ink': ['#d3fff2', 'text'],
    'toast-surface': ['#21483f', 'surface'],
    'toast-edge': ['#477f6d', 'edge'],
    'toast-glow': ['#00000050', 'glow'],
    'agent-live-surface': ['#5eead0', 'fill'],
    'agent-live-surface-2': ['#f2fffc', 'fill'],
    'agent-live-surface-3': ['#c3a8ff', 'fill'],
    'agent-glow-dim-color': ['#75f6db40', 'glow'],
    'agent-glow-bright-color': ['#75f6dbcc', 'glow'],
    'transcript-pre-ink': ['#c6d4e8', 'text'],
    'transcript-pre-surface': ['#0b1424', 'surface'],
    'transcript-call-transcript-pre-edge': ['#3a3424', 'edge'],
    'tool-heredoc-ink': ['#b8c9a8', 'text'],
    'tool-diff-tool-hunk-ink': ['#8db4ff', 'text'],
    'transcript-result-error-transcript-pre-edge': ['#5a2a36', 'edge'],
    'theme-shadow': ['#00000012', 'glow'],
    'browser-surface': ['#0b111f', 'surface'],
    'favicon-surface': ['#2d43da', 'fill'],
    'favicon-ink': ['#ffffff', 'inverse'],
  };
  const foundation = {
    'color-scheme': 'dark',
    'font-body':
      "Inter,\n    ui-sans-serif,\n    -apple-system,\n    BlinkMacSystemFont,\n    'Segoe UI',\n    sans-serif",
    'font-size-18px': '18px',
    'duration-0-16s': '0.16s',
    'space-negative-1px': '-1px',
    'space-18px': '18px',
    'font-brand': 'Georgia, serif',
    'font-size-48px': '48px',
    'font-weight-700': '700',
    'line-height-1': '1',
    'space-20px': '20px',
    'space-28px': '28px',
    'brand-text-shadow': '0 0 25px var(--brand-glow)',
    'border-radius-2px': '2px',
    'brand-dot-box-shadow': '0 0 12px var(--brand-dot-glow)',
    'border-radius-12px': '12px',
    'rail-link-selected-box-shadow':
      '0 0 25px var(--rail-link-selected-glow),\n    inset 0 0 16px var(--rail-link-selected-glow-2)',
    'space-1px': '1px',
    'space-5px': '5px',
    'border-radius-11px': '11px',
    'font-size-12px': '12px',
    'line-height-16px': '16px',
    'space-86px': '86px',
    'space-34px': '34px',
    'space-15px': '15px',
    'font-size-15px': '15px',
    'font-size-16px': '16px',
    'font-weight-550': '550',
    'border-radius-8px': '8px',
    'font-size-14px': '14px',
    'font-weight-600': '600',
    'space-22px': '22px',
    'space-8px': '8px',
    'space-16px': '16px',
    'font-weight-500': '500',
    'border-radius-6px': '6px',
    'space-6px': '6px',
    'space-10px': '10px',
    'status-dot-box-shadow': '0 0 12px currentcolor',
    'space-40px': '40px',
    'space-32px': '32px',
    'font-mono': 'ui-monospace, SFMono-Regular, Menlo, monospace',
    'line-height-1-6': '1.6',
    'letter-spacing-1-5px': '1.5px',
    'space-14px': '14px',
    'font-size-42px': '42px',
    'letter-spacing-negative-1-5px': '-1.5px',
    'font-weight-570': '570',
    'line-height-1-15': '1.15',
    'heading-dot-text-shadow': '0 0 18px var(--heading-dot-glow)',
    'font-size-17px': '17px',
    'line-height-1-65': '1.65',
    'space-11px': '11px',
    'space-17px': '17px',
    'line-height-1-35': '1.35',
    'button-primary-box-shadow': '0 0 24px var(--button-primary-glow)',
    'button-primary-hover-box-shadow': '0 0 25px var(--button-primary-hover-glow)',
    'font-size-23px': '23px',
    'font-weight-400': '400',
    'space-36px': '36px',
    'space-19px': '19px',
    'metric-box-shadow': '0 7px 25px var(--metric-glow)',
    'space-9px': '9px',
    'line-height-1-5': '1.5',
    'font-size-38px': '38px',
    'line-height-1-1': '1.1',
    'space-4px': '4px',
    'line-height-1-4': '1.4',
    'line-height-1-55': '1.55',
    'space-12px': '12px',
    'font-size-24px': '24px',
    'letter-spacing-negative-0-5px': '-0.5px',
    'space-2px': '2px',
    'live-label-span-box-shadow': '0 0 10px var(--live-label-span-glow)',
    'space-3px': '3px',
    'agent-card-box-shadow': '0 9px 28px var(--metric-glow)',
    'agent-card-has-status-working-box-shadow':
      '0 0 25px var(--agent-card-has-status-working-glow),\n    0 9px 28px var(--metric-glow)',
    'space-23px': '23px',
    'space-24px': '24px',
    'space-13px': '13px',
    'border-radius-10px': '10px',
    'agent-avatar-lead-box-shadow': '0 0 18px var(--agent-avatar-lead-glow)',
    'font-size-19px': '19px',
    'space-7px': '7px',
    'border-radius-5px': '5px',
    'line-height-1-7': '1.7',
    'border-radius-7px': '7px',
    'font-size-13px': '13px',
    'space-50px': '50px',
    'border-radius-16px': '16px',
    'font-size-40px': '40px',
    'empty-node-box-shadow': '0 0 35px var(--empty-node-glow)',
    'font-size-26px': '26px',
    'letter-spacing-negative-0-4px': '-0.4px',
    'line-height-1-75': '1.75',
    'space-26px': '26px',
    'space-30px': '30px',
    'duration-0-2s': '0.2s',
    'border-radius-10px-0-0-10px': '10px 0 0 10px',
    'border-radius-0-10px-10px-0': '0 10px 10px 0',
    'font-size-20px': '20px',
    'duration-0-15s': '0.15s',
    'border-radius-3px': '3px',
    'task-square-tip-box-shadow': '0 8px 24px var(--task-square-tip-glow)',
    'space-negative-4px': '-4px',
    'duration-0-6s': '0.6s',
    'task-card-revealed-box-shadow': '0 0 0 2px var(--task-card-revealed-glow)',
    'font-size-22px': '22px',
    'font-size-1-12em': '1.12em',
    'font-weight-650': '650',
    'font-size-1-3em': '1.3em',
    'font-size-1-2em': '1.2em',
    'font-size-0-92em': '0.92em',
    'border-radius-4px': '4px',
    'line-height-1-45': '1.45',
    'conversation-list-picker-list-box-shadow': '0 14px 44px var(--task-square-tip-glow)',
    'font-size-21px': '21px',
    'space-25px': '25px',
    'space-44px': '44px',
    'border-radius-14px': '14px',
    'font-size-32px': '32px',
    'space-21px': '21px',
    'message-new-message-main-box-shadow': '0 0 0 7px var(--message-new-message-main-surface)',
    'message-revealed-message-main-box-shadow': '0 0 0 6px var(--message-revealed-message-main-surface)',
    'space-27px': '27px',
    'composer-box-box-shadow': '0 8px 25px var(--metric-glow)',
    'composer-box-focus-within-box-shadow':
      '0 0 0 3px var(--composer-box-focus-within-glow),\n    0 0 24px var(--composer-box-focus-within-glow-2)',
    'duration-1-5s': '1.5s',
    'ease-pulse': 'ease-in-out',
    'send-button-box-shadow': '0 0 18px var(--send-button-glow)',
    'border-radius-9px': '9px',
    'mention-menu-box-shadow': '0 10px 40px var(--mention-menu-glow)',
    'new-messages-box-shadow': '0 5px 18px var(--new-messages-glow)',
    'border-radius-24px': '24px',
    'border-radius-15px': '15px',
    'agent-dialog-box-shadow': '0 20px 120px var(--agent-dialog-glow),\n    0 0 50px var(--agent-dialog-glow-2)',
    'agent-dialog-backdrop-backdrop-filter': 'blur(7px)',
    'letter-spacing-negative-0-8px': '-0.8px',
    'font-size-30px': '30px',
    'font-weight-300': '300',
    'toast-box-shadow': '0 8px 30px var(--toast-glow)',
    'agent-live-background-image':
      'linear-gradient(\n    100deg,\n    var(--agent-live-surface) 0%,\n    var(--agent-live-surface-2) 12%,\n    var(--agent-live-surface-3) 25%,\n    var(--agent-live-surface) 40%,\n    var(--agent-live-surface) 50%,\n    var(--agent-live-surface-2) 62%,\n    var(--agent-live-surface-3) 75%,\n    var(--agent-live-surface) 90%,\n    var(--agent-live-surface) 100%\n  )',
    'motion-agent-duration': '2.4s',
    'agent-glow-dim-filter': 'drop-shadow(0 0 2px var(--agent-glow-dim-color))',
    'agent-glow-bright-filter': 'drop-shadow(0 0 9px var(--agent-glow-bright-color))',
    'space-48px': '48px',
    'space-45px': '45px',
    'font-size-46px': '46px',
    'space-42px': '42px',
    'space-29px': '29px',
    'space-72px': '72px',
    'letter-spacing-1-2px': '1.2px',
    'font-size-34px': '34px',
    'space-64px': '64px',
    'letter-spacing-1px': '1px',
    'font-size-39px': '39px',
    'space-31px': '31px',
    'space-37px': '37px',
    'font-size-35px': '35px',
    'font-size-11px': '11px',
    'letter-spacing-0-04em': '0.04em',
    'letter-spacing-negative-0-3px': '-0.3px',
    'motion-panel-opacity': '0.4',
    'motion-conversation-opacity': '0.4',
    'motion-message-opacity': '0.35',
    'motion-message-offset': '5px',
    'motion-panel-duration': '180ms',
    'motion-conversation-duration': '160ms',
    'motion-message-duration': '220ms',
    'motion-status-duration': '520ms',
    'motion-expand-duration': '260ms',
    'motion-easing': 'cubic-bezier(0.2, 0.7, 0.2, 1)',
    'motion-status-start': '0 0 0 0 transparent',
    'motion-status-peak': '0 0 0 3px currentColor',
    'motion-status-end': '0 0 0 6px transparent',
    'motion-origin-radius': '12px',
    'motion-dialog-radius': '15px',
    'grid-spacing': '40px',
    'favicon-radius': '18',
    'favicon-font-size': '48',
    'task-square-ready-surface': 'var(--rail-badge-surface)',
  };
  const original = Object.fromEntries(Object.entries(palette).map(([name, [value]]) => [name, value]));
  Object.assign(original, foundation);

  function hsl(hex) {
    const [r, g, b] = hex
      .slice(1, 7)
      .match(/../g)
      .map((part) => parseInt(part, 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const light = (max + min) / 2;
    const hue = !delta ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    return [(hue * 60 + 360) % 360, delta ? delta / (1 - Math.abs(2 * light - 1)) : 0, light];
  }

  function hex(hue, saturation, light, alpha = '') {
    const a = saturation * Math.min(light, 1 - light);
    const channel = (n) => {
      const k = (n + hue / 30) % 12;
      return Math.round(255 * (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
        .toString(16)
        .padStart(2, '0');
    };
    return `#${channel(0)}${channel(8)}${channel(4)}${alpha}`;
  }

  // The ten digit positions own climate, accent, chroma/mood, type, corners, weight, companion,
  // grid, tempo and shadow depth respectively. docs/development.md records the vocabulary and formulas.
  function fromSeed(seed) {
    const digits = [...seed].map(Number);
    const [climate, accent, chroma, type, corners, weight, companion, grid, tempo, depth] = digits;
    const light = climate % 2 === 0;
    const baseHue = { 2: 42, 3: 222, 7: 22 }[climate];
    const accentHue = accent * 36;
    const companionHue = (accentHue + 90 + companion * 9) % 360;
    const saturation = 0.35 + chroma * 0.03;
    const tokens = { ...original };
    for (const [name, [value, role]] of Object.entries(palette)) {
      const [oldHue, oldSaturation, oldLight] = hsl(value);
      let hue = baseHue;
      if (oldSaturation > 0.25) {
        if (oldHue >= 245 && oldHue < 325) hue = companionHue;
        else if (oldHue >= 325 || oldHue < 15) hue = 330 + chroma;
        else if (oldHue < 70) hue = 38 + chroma;
        else if (oldHue < 155) hue = 138 + chroma;
        else if (oldHue < 190) hue = accentHue;
      }
      if (name === 'accent') hue = accentHue;
      if (name === 'green') hue = 138 + chroma;
      if (name === 'amber') hue = 38 + chroma;
      if (name === 'red') hue = 330 + chroma;
      const levels = light
        ? {
            text: 0.16 + (1 - oldLight) * 0.14,
            inverse: 0.99,
            surface: 0.97 - oldLight * 0.09,
            fill: 0.26,
            edge: 0.68,
            glow: 0.24,
          }
        : {
            text: 0.72 + oldLight * 0.18,
            inverse: 0.07,
            surface: 0.065 + oldLight * 0.22,
            fill: 0.78,
            edge: 0.34,
            glow: 0.68,
          };
      const sat = ['surface', 'edge'].includes(role) ? saturation * 0.35 : saturation;
      tokens[name] = hex(hue, oldSaturation < 0.08 ? 0 : sat, levels[role], value.slice(7));
    }
    const statusHues = {
      idle: 215 + chroma,
      working: 138 + chroma,
      blocked: 38 + chroma,
      done: 280 + chroma,
      stopped: 0,
      error: 340 + chroma,
    };
    for (const [status, hue] of Object.entries(statusHues)) {
      const neutral = status === 'stopped';
      tokens[`status-${status}-ink`] = hex(
        hue,
        neutral ? 0 : 0.78 + chroma * 0.02,
        neutral ? (light ? 0.43 : 0.58) : light ? 0.26 - chroma * 0.003 : 0.74 + chroma * 0.003,
      );
      tokens[`status-${status}-surface`] = hex(hue, neutral ? 0 : 0.55, light ? (neutral ? 0.97 : 0.94) : 0.14);
      tokens[`status-${status}-edge`] = hex(hue, neutral ? 0 : 0.65, light ? 0.58 : 0.43);
    }
    tokens.green = tokens['status-working-ink'];
    tokens.amber = tokens['status-blocked-ink'];
    tokens.red = tokens['status-error-ink'];
    for (const [task, status] of [
      ['', 'working'],
      ['-ready', 'done'],
      ['-verified', 'stopped'],
    ]) {
      for (const role of ['ink', 'surface', 'edge'])
        tokens[`task-status${task}-${role}`] = tokens[`status-${status}-${role}`];
    }
    tokens['task-square-ready-surface'] = tokens['status-done-ink'];
    tokens['task-square-archived-surface'] = tokens['status-stopped-ink'];
    const bodyFonts = [
      'Avenir Next, Avenir, Helvetica, Arial, sans-serif',
      'ui-monospace, SFMono-Regular, Menlo, monospace',
      'Iowan Old Style, Palatino Linotype, Book Antiqua, Palatino, Georgia, serif',
    ];
    tokens['font-body'] = bodyFonts[type % 3];
    tokens['font-brand'] = bodyFonts[type % 3];
    tokens['color-scheme'] = light ? 'light' : 'dark';
    tokens['grid-spacing'] = `${24 + grid * 2}px`;
    tokens['favicon-radius'] = String(corners * 2);
    const radiusScale = corners <= 3 ? 0.2 : corners <= 6 ? 1.25 : 2.5;
    for (const [name, value] of Object.entries(tokens)) {
      if (/^(border-radius|motion-.*-radius)/.test(name)) {
        tokens[name] = value.replace(/[\d.]+px/g, (px) => `${Number.parseFloat(px) * radiusScale}px`);
      } else if (name.startsWith('font-weight-')) {
        tokens[name] = String(Math.min(800, Number(value) + weight * 5));
      } else if (name.startsWith('duration-') || /^motion-.*-duration$/.test(name)) {
        tokens[name] = value.replace(/[\d.]+/, (number) => String(Number(number) * (0.5 + tempo * 0.1)));
      } else if (name.endsWith('box-shadow') || name.endsWith('text-shadow')) {
        tokens[name] = `0 ${depth}px ${depth * 3}px var(--theme-shadow)`;
      } else if (name.startsWith('agent-glow-') && name.endsWith('filter')) {
        tokens[name] = `drop-shadow(0 0 ${depth}px var(--accent))`;
      } else if (name.startsWith('space-')) {
        tokens[name] = value.replace(/-?[\d.]+px/g, (px) => `${Number.parseFloat(px) * (0.9 + grid * 0.02)}px`);
      } else if (name.startsWith('font-size-')) {
        tokens[name] = value.replace(/[\d.]+/, (number) => String(Number(number) * (1 + (type - 5) * 0.005)));
      }
    }
    tokens['theme-shadow'] = hex(baseHue, saturation * 0.35, light ? 0.2 : 0.02, light ? '24' : '80');
    return {
      id: `seed-${seed}`,
      name: `${{ 0: 'Ember', 2: 'Citron', 5: 'Tidal' }[accent]} ${{ 0: 'Observatory', 2: 'Terminal', 3: 'Ledger' }[chroma]}`,
      seed,
      tokens,
    };
  }

  const themes = [
    { id: 'original', name: 'Mu original', seed: null, tokens: original },
    fromSeed('2533678612'),
    fromSeed('3205321552'),
    fromSeed('7024703569'),
  ];
  const storageKey = 'mu-theme';
  const root = document.documentElement;
  const resolve = (id) => themes.find((theme) => theme.id === id) ?? themes[0];

  function apply(id) {
    const theme = resolve(id);
    root.classList.add('theme-applying');
    for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(`--${name}`, value);
    root.dataset.theme = theme.id;
    document.querySelector('meta[name="theme-color"]').setAttribute('content', theme.tokens['browser-surface']);
    const icon = document.querySelector('link[rel="icon"]');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="${theme.tokens['favicon-radius']}" fill="${theme.tokens['favicon-surface']}"/><text x="32" y="44" font-size="${theme.tokens['favicon-font-size']}" text-anchor="middle" fill="${theme.tokens['favicon-ink']}" font-family="${theme.tokens['font-brand']}">μ</text></svg>`;
    icon.setAttribute('href', `data:image/svg+xml,${encodeURIComponent(svg)}`);
    document.querySelector('.theme-control')?.setAttribute('title', theme.name);
    // Commit both foregrounds and backgrounds together; interpolating only one can make text unreadable.
    root.getBoundingClientRect();
    root.classList.remove('theme-applying');
    document.dispatchEvent(new CustomEvent('mu-theme-change', { detail: theme.id }));
    return theme;
  }

  apply(localStorage.getItem(storageKey));
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      const select = /** @type {HTMLSelectElement} */ (document.getElementById('theme-picker'));
      for (const theme of themes) select.add(new Option(theme.name, theme.id));
      select.value = root.dataset.theme;
      select.closest('label')?.setAttribute('title', resolve(select.value).name);
      select.addEventListener('change', () => {
        const theme = apply(select.value);
        localStorage.setItem(storageKey, theme.id);
      });
      window.addEventListener('storage', (event) => {
        if ((event.key !== storageKey && event.key !== null) || event.storageArea !== localStorage) return;
        select.value = apply(event.newValue).id;
      });
    },
    { once: true },
  );

  return { themes, apply, storageKey };
})();
