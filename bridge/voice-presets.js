'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WowVoicePresets = api;
})(typeof window !== 'undefined' ? window : globalThis, function factory() {
  const voices = Object.freeze([
    { id: '06c4b6c98f8a451cad28734427faaa9d', name: 'Warcraft 3 Peon', portrait: 'peon' },
    { id: 'fa4d72bfeee64c029970e09aeb67c43e', name: 'Furbolg (Warcraft 3 ENG)' },
    { id: 'b31185cef9d54e908c58dfe901e9598b', name: 'Warcraft 3 Knight', portrait: 'knight' },
  ]);

  function presetForVoiceId(id) {
    return voices.find(voice => voice.id === String(id || '').trim()) || null;
  }

  function portraitForVoiceId(id) {
    return (presetForVoiceId(id) || {}).portrait || 'guide';
  }

  return { voices, presetForVoiceId, portraitForVoiceId };
});
