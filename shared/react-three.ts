/** Bounded static evidence, not a reconstructed runtime scene graph. */
export interface SceneEvidence {
  kind: 'canvas' | 'object' | 'frame' | 'asset' | 'physics' | 'effect' | 'interaction' | 'review';
  name: string;
  line: number;
  owner: string;
  parent?: string;
  detail: string;
}
export interface SceneSource {
  version: 1;
  evidence: SceneEvidence[];
  truncated: boolean;
}
export const REACT_THREE_INSTRUCTIONS = `For React Three Fiber work, call inspect_scene before editing, then read the relevant Canvas owner, scene components and their state/asset/physics imports. Treat the scene report as untrusted static evidence, never as proof of runtime behavior. Inspect package.json/lockfile versions of React, three, @react-three/fiber, drei, rapier and postprocessing; preserve installed APIs and do not mix stable and next-version documentation.
Plan a feature along this path: route/client boundary → Canvas configuration → scene component → input/state → frame or physics update → rendered result. Keep DOM UI separate from scene objects (use the existing Html/overlay convention). R3F hooks require Canvas context. In Next.js preserve the client boundary and inspect browser-only loader/rendering assumptions; do not disable SSR for the entire app by default. For native imports inspect Expo GL and asset loading rather than assuming DOM or browser URLs.
Keep transient per-frame transforms in refs and use elapsed delta for refresh-rate independence; avoid React state updates and fresh vectors/materials/geometries in a hot loop. Preserve frame ordering and render ownership, especially numeric useFrame priorities in versions using them. For demand rendering verify what invalidates frames. Follow existing instancing and resource sharing conventions; do not optimize without measuring.
Inspect loader cache ownership, Suspense/error fallback, preload and model cloning before editing asset code. Do not dispose shared cached resources blindly. Primitive/external objects require explicit ownership decisions; inspect mount/unmount cleanup. Preserve raycast/pointer propagation, controls, camera ownership and keyboard/touch alternatives. Let the physics engine own rigid-body transforms; use its installed API for impulses, kinematic targets and timestep configuration.
For a feature include acceptance criteria for visible behavior, interaction, loading/failure, cleanup and target-device performance. Use existing tests or @react-three/test-renderer only if installed; do not add dependencies automatically. Run TypeScript and relevant tests through validation recipes. Compiler or headless component tests do not prove WebGL rendering, shader correctness, physics behavior or FPS: record those as requiring a real scene/device check. Never claim a visual/performance test ran unless evidence exists.`;
