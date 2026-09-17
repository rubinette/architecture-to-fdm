import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { processModel } from './solid.js';
const ready = Module({ locateFile: () => wasmUrl }).then(m => { m.setup(); return m; });
self.onmessage = async ({ data }) => {
  try {
    const result = processModel(await ready, data.parts, data.config);
    self.postMessage({ id: data.id, ...result }, [result.positions.buffer]);
  } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
