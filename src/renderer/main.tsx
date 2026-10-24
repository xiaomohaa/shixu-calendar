import React from 'react';
import '../platform/tauri';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './styles.css';
import './almanac.css';
import './desktop.css';
import './native-calendar.css';
import './month.css';
import './display.css';
import './reference-calendar.css';
import './editor-popover.css';
import './year-grid.css';
import './liquid-glass.css';
import './compact-toolbar.css';
import './time-blocks.css';
import './reference-editor.css';
const root = createRoot(document.getElementById('root')!);
const notification = !!window.__TAURI_INTERNALS__ && getCurrentWindow().label.startsWith('reminder-');
if (notification) {
  document.documentElement.dataset.surface = 'notification';
  void import('./NotificationToast').then(({ NotificationToast }) => root.render(<React.StrictMode><NotificationToast/></React.StrictMode>));
} else {
  void import('./App').then(({ App }) => root.render(<React.StrictMode><App/></React.StrictMode>));
}
