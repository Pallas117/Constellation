/**
 * compileAsync without its failure mode (used by components/scene/ShaderWarmup.tsx).
 *
 * three's own poll reads every compiled material's program, and a material disposed or swapped
 * while it polls (live drivers re-render the scene) has none: its timer throws "reading
 * 'isReady'", the promise never settles and the scene waited for the 20 s fallback (20.7 s of
 * "Preparing the field model…" on a phone, 18 Nov 2026). Here: the same synchronous compile, then
 * a poll of the renderer's live programs, which only ever holds programs that exist.
 * KHR_parallel_shader_compile keeps it non-blocking.
 */

/**
 * The program list of THREE.WebGLRenderer (structural, so the test needs no WebGL). three's
 * WebGLProgram has isReady() at runtime (its own compileAsync calls it), but @types/three
 * doesn't declare it, so it is read as optional: a program without it counts as ready.
 */
interface ProgramInfo {
  programs: ReadonlyArray<object> | null;
}

const isPending = (program: object): boolean => {
  const isReady = (program as { isReady?: unknown }).isReady;
  return typeof isReady === "function" && !isReady.call(program);
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Compiles synchronously (call it while hidden objects are shown), then resolves once every live
 * program reports ready, `cancelled()` turns true, or `maxMs` passes. Never rejects on a program
 * torn down mid-poll.
 */
export async function compileQuietly<S, C>(
  gl: { compile(scene: S, camera: C): unknown; info: ProgramInfo },
  scene: S,
  camera: C,
  cancelled: () => boolean,
  maxMs: number,
  pollMs = 10,
): Promise<void> {
  gl.compile(scene, camera);
  const start = performance.now();
  while (!cancelled() && performance.now() - start < maxMs) {
    let pending = false;
    for (const program of gl.info.programs ?? []) {
      try {
        if (isPending(program)) pending = true;
      } catch {
        // A program torn down mid-poll is not one to wait for.
      }
    }
    if (!pending) return;
    await wait(pollMs);
  }
}
