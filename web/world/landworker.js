// Works out the land's mesh away from the page's own thread: it takes a
// second or so, and the page has a game to run meanwhile. When asked
// `early`, the shape goes back first and the sunlight on it after.
import { landSurfaces } from './land.js';

self.onmessage = (ev) => {
  const { id, terrain, x0, dx, scale, sun, early } = ev.data;
  const shaped = early ? (rings) => self.postMessage({ id, scale, rings, lit: false }) : null;
  const rings = landSurfaces(terrain, x0, dx, scale, sun, shaped);
  const transfer = [];
  for (const r of rings) transfer.push(r.y.buffer, r.n.buffer, r.sun.buffer);
  self.postMessage({ id, scale, rings, lit: true }, transfer);
};
