'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wowVoice', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: value => ipcRenderer.invoke('config:save', value),
  sendAudio: arrayBuffer => ipcRenderer.send('capture:audio', arrayBuffer),
  forceEnd: () => ipcRenderer.send('capture:force-end'),
  cancel: () => ipcRenderer.send('capture:cancel'),
  audioEnded: () => ipcRenderer.send('audio:ended'),
  openGuideSource: url => ipcRenderer.send('guide:open-source', url),
  on: (channel, fn) => {
    const allowed = ['capture:start', 'capture:stop', 'audio:play', 'audio:stream', 'audio:stream-end', 'audio:volume', 'config:announce', 'status', 'log', 'guide:sources'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_event, value) => fn(value));
  },
});
