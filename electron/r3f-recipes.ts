import { readText } from './workspace';

export type RecipeEdit = { path: string; content: string };

const gameSource = `export type Point = Readonly<{ x: number; y: number }>;
export type Direction = 'up' | 'down' | 'left' | 'right';
export type GameStatus = 'playing' | 'game-over';
export type GameState = Readonly<{
  snake: readonly Point[];
  food: Point;
  direction: Direction;
  pendingDirection: Direction;
  score: number;
  status: GameStatus;
}>;

export const BOARD_SIZE = 18;
export const INITIAL_SNAKE: readonly Point[] = [
  { x: 1, y: 0 },
  { x: 0, y: 0 },
  { x: -1, y: 0 },
];

const vectors: Record<Direction, Point> = {
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const opposite: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

export const samePoint = (left: Point, right: Point) =>
  left.x === right.x && left.y === right.y;

export function spawnFood(snake: readonly Point[], random = Math.random): Point {
  const available: Point[] = [];
  const edge = Math.floor(BOARD_SIZE / 2);
  for (let y = -edge; y < edge; y += 1) {
    for (let x = -edge; x < edge; x += 1) {
      const candidate = { x, y };
      if (!snake.some((segment) => samePoint(segment, candidate))) available.push(candidate);
    }
  }
  if (!available.length) return { x: 0, y: 0 };
  return available[Math.min(available.length - 1, Math.floor(random() * available.length))];
}

export function createInitialGame(random = Math.random): GameState {
  return {
    snake: INITIAL_SNAKE.map((point) => ({ ...point })),
    food: spawnFood(INITIAL_SNAKE, random),
    direction: 'right',
    pendingDirection: 'right',
    score: 0,
    status: 'playing',
  };
}

export function changeDirection(state: GameState, direction: Direction): GameState {
  if (opposite[state.direction] === direction) return state;
  return { ...state, pendingDirection: direction };
}

export function stepGame(state: GameState, random = Math.random): GameState {
  if (state.status !== 'playing') return state;
  const direction = state.pendingDirection;
  const vector = vectors[direction];
  const nextHead = {
    x: state.snake[0].x + vector.x,
    y: state.snake[0].y + vector.y,
  };
  const edge = Math.floor(BOARD_SIZE / 2);
  const wrap = (coordinate: number) =>
    coordinate < -edge ? edge - 1 : coordinate >= edge ? -edge : coordinate;
  const head = { x: wrap(nextHead.x), y: wrap(nextHead.y) };
  const ate = samePoint(head, state.food);
  const occupied = ate ? state.snake : state.snake.slice(0, -1);
  const hitSelf = occupied.some((segment) => samePoint(segment, head));
  if (hitSelf) return { ...state, direction, status: 'game-over' };

  const snake = ate
    ? [head, ...state.snake]
    : [head, ...state.snake.slice(0, Math.max(0, state.snake.length - 1))];
  return {
    ...state,
    snake,
    food: ate ? spawnFood(snake, random) : state.food,
    direction,
    score: ate ? state.score + 1 : state.score,
  };
}
`;

const appSource = `import { Canvas } from '@react-three/fiber';
import { useEffect, useState } from 'react';
import './App.css';
import {
  BOARD_SIZE,
  changeDirection,
  createInitialGame,
  stepGame,
  type Direction,
  type GameState,
} from './game';

const keys: Record<string, Direction | undefined> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
};

function Scene({ game }: { game: GameState }) {
  return (
    <>
      <color attach="background" args={['#07111f']} />
      <ambientLight intensity={1.4} />
      <directionalLight position={[5, 8, 12]} intensity={2.5} color="#b9f9ff" />
      <mesh position={[0, 0, -0.55]}>
        <planeGeometry args={[BOARD_SIZE + 0.5, BOARD_SIZE + 0.5]} />
        <meshStandardMaterial color="#0c1d2d" roughness={0.8} metalness={0.15} />
      </mesh>
      {game.snake.map((segment, index) => (
        <mesh key={index + ':' + segment.x + ':' + segment.y} position={[segment.x, segment.y, 0]}>
          <boxGeometry args={[0.82, 0.82, index === 0 ? 0.64 : 0.46]} />
          <meshStandardMaterial
            color={index === 0 ? '#d9ff4f' : '#55e69b'}
            emissive={index === 0 ? '#789200' : '#0b5a37'}
            emissiveIntensity={0.45}
            roughness={0.32}
          />
        </mesh>
      ))}
      <mesh position={[game.food.x, game.food.y, 0.08]}>
        <sphereGeometry args={[0.4, 24, 24]} />
        <meshStandardMaterial color="#ff5576" emissive="#a30035" emissiveIntensity={0.7} />
      </mesh>
    </>
  );
}

function App() {
  const [game, setGame] = useState(() => createInitialGame());

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = keys[event.code];
      if (direction) {
        event.preventDefault();
        setGame((current) => changeDirection(current, direction));
      }
      if (event.code === 'Enter' && game.status === 'game-over') setGame(createInitialGame());
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [game.status]);

  useEffect(() => {
    if (game.status !== 'playing') return;
    const timer = window.setTimeout(
      () => setGame((current) => stepGame(current)),
      Math.max(72, 150 - game.score * 4),
    );
    return () => window.clearTimeout(timer);
  }, [game]);

  return (
    <main className="game-shell">
      <header className="hud">
        <div>
          <span className="eyebrow">R3F ARCADE</span>
          <h1>Neon Snake</h1>
        </div>
        <div className="score" aria-label={'Score ' + game.score}>
          <span>Score</span>
          <strong>{String(game.score).padStart(2, '0')}</strong>
        </div>
      </header>
      <section className="game-stage" aria-label="Snake game board">
        <Canvas orthographic camera={{ position: [0, 0, 20], zoom: 28 }} dpr={[1, 2]}>
          <Scene game={game} />
        </Canvas>
        {game.status === 'game-over' && (
          <div className="game-over" role="dialog" aria-label="Game over">
            <span>Run ended</span>
            <strong>{game.score} points</strong>
            <button type="button" onClick={() => setGame(createInitialGame())}>
              Play again
            </button>
          </div>
        )}
      </section>
      <footer>
        <span>Move with arrows or WASD</span>
        <span>Enter restarts after a collision</span>
      </footer>
    </main>
  );
}

export default App;
`;

const appCss = `:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; overflow: hidden; background: radial-gradient(circle at 50% -20%, #193b52, #060a12 58%); }
button { font: inherit; }
.game-shell { width: min(92vw, 760px); margin: 0 auto; padding: 28px 0 22px; }
.hud, footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }
.eyebrow { color: #55e69b; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.2em; }
h1 { margin: 4px 0 0; font-size: clamp(2rem, 5vw, 3.6rem); line-height: 0.94; letter-spacing: -0.055em; }
.score { display: grid; justify-items: end; color: #95a7b8; text-transform: uppercase; font-size: 0.68rem; letter-spacing: 0.14em; }
.score strong { color: #f5fbff; font-size: 2rem; letter-spacing: 0; }
.game-stage { position: relative; height: min(74vh, 660px); margin: 22px 0 18px; overflow: hidden; border: 1px solid rgba(118, 237, 190, 0.28); border-radius: 28px; background: #07111f; box-shadow: 0 30px 90px rgba(0,0,0,.48), inset 0 0 0 1px rgba(255,255,255,.04); }
.game-stage::after { content: ''; pointer-events: none; position: absolute; inset: 0; background: linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px); background-size: 28px 28px; }
.game-over { position: absolute; inset: 0; z-index: 2; display: grid; place-content: center; justify-items: center; gap: 10px; background: rgba(3,8,15,.78); backdrop-filter: blur(10px); }
.game-over span { color: #ff7892; font-size: .76rem; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; }
.game-over strong { font-size: 2.2rem; }
.game-over button { margin-top: 10px; border: 0; border-radius: 999px; padding: 12px 22px; color: #06110c; background: #d9ff4f; font-weight: 800; cursor: pointer; }
footer { color: #8295a7; font-size: .8rem; }
@media (max-width: 560px) { .game-shell { padding-top: 18px; } .game-stage { height: 70vh; border-radius: 20px; } footer { align-items: flex-start; flex-direction: column; gap: 5px; } }
`;

const indexCss = `html { background: #060a12; }
body { min-height: 100vh; }
#root { min-height: 100vh; }
`;

const testSource = `import test from 'node:test';
import assert from 'node:assert/strict';
import { changeDirection, createInitialGame, spawnFood, stepGame, type GameState } from '../src/game.ts';

test('moves one grid cell and keeps its length', () => {
  const state = createInitialGame(() => 0);
  const next = stepGame({ ...state, food: { x: 8, y: 8 } });
  assert.deepEqual(next.snake[0], { x: 2, y: 0 });
  assert.equal(next.snake.length, 3);
});

test('eating grows the snake and increments score', () => {
  const state = createInitialGame(() => 0);
  const next = stepGame({ ...state, food: { x: 2, y: 0 } }, () => 0);
  assert.equal(next.snake.length, 4);
  assert.equal(next.score, 1);
  assert.ok(!next.snake.some((segment) => segment.x === next.food.x && segment.y === next.food.y));
});

test('rejects an immediate reverse turn', () => {
  const state = createInitialGame(() => 0);
  assert.equal(changeDirection(state, 'left'), state);
  assert.equal(changeDirection(state, 'up').pendingDirection, 'up');
});

test('wraps through every board edge', () => {
  const base = createInitialGame();
  assert.deepEqual(stepGame({ ...base, snake: [{ x: 8, y: 0 }], food: { x: 2, y: 2 } }).snake[0], { x: -9, y: 0 });
  assert.deepEqual(stepGame({ ...base, snake: [{ x: -9, y: 0 }], direction: 'left', pendingDirection: 'left', food: { x: 2, y: 2 } }).snake[0], { x: 8, y: 0 });
  assert.deepEqual(stepGame({ ...base, snake: [{ x: 0, y: 8 }], direction: 'up', pendingDirection: 'up', food: { x: 2, y: 2 } }).snake[0], { x: 0, y: -9 });
  assert.deepEqual(stepGame({ ...base, snake: [{ x: 0, y: -9 }], direction: 'down', pendingDirection: 'down', food: { x: 2, y: 2 } }).snake[0], { x: 0, y: 8 });
});

test('detects self collisions', () => {
  const base = createInitialGame();
  const self: GameState = {
    snake: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 }],
    food: { x: 5, y: 5 }, direction: 'up', pendingDirection: 'up', score: 3, status: 'playing',
  };
  assert.equal(stepGame(self).status, 'game-over');
});

test('food never spawns on the snake', () => {
  const snake = [{ x: -9, y: -9 }, { x: -8, y: -9 }];
  assert.deepEqual(spawnFood(snake, () => 0), { x: -7, y: -9 });
});
`;

export async function r3fSnakeRecipe(root: string): Promise<RecipeEdit[]> {
  let packageJson: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    [key: string]: unknown;
  };
  let existingProject = true;
  try {
    packageJson = JSON.parse(await readText(root, 'package.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    existingProject = false;
    packageJson = {
      name: 'neon-snake',
      private: true,
      version: '0.0.0',
      type: 'module',
      packageManager: 'pnpm@10.17.1',
      dependencies: {
        '@react-three/fiber': '^9.3.0',
        react: '^19.1.1',
        'react-dom': '^19.1.1',
        three: '^0.180.0',
      },
      devDependencies: {
        '@types/react': '^19.1.16',
        '@types/react-dom': '^19.1.9',
        '@types/three': '^0.180.0',
        '@vitejs/plugin-react': '^5.0.4',
        typescript: '~5.9.3',
        vite: '^7.1.9',
      },
    };
  }
  packageJson.scripts = {
    ...packageJson.scripts,
    dev: packageJson.scripts?.dev ?? 'vite',
    build: packageJson.scripts?.build ?? 'tsc -b && vite build',
    test: 'node --test --experimental-strip-types tests/game.test.ts',
  };
  const bootstrap: RecipeEdit[] = existingProject
    ? []
    : [
        {
          path: 'index.html',
          content:
            '<!doctype html>\n<html lang="en">\n  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Neon Snake</title></head>\n  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>\n</html>\n',
        },
        {
          path: 'src/main.tsx',
          content:
            "import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './index.css';\n\ncreateRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);\n",
        },
        {
          path: 'tsconfig.json',
          content:
            '{\n  "compilerOptions": {\n    "target": "ES2022",\n    "useDefineForClassFields": true,\n    "lib": ["ES2022", "DOM", "DOM.Iterable"],\n    "allowJs": false,\n    "skipLibCheck": true,\n    "esModuleInterop": true,\n    "allowSyntheticDefaultImports": true,\n    "strict": true,\n    "forceConsistentCasingInFileNames": true,\n    "module": "ESNext",\n    "moduleResolution": "Bundler",\n    "resolveJsonModule": true,\n    "isolatedModules": true,\n    "noEmit": true,\n    "jsx": "react-jsx"\n  },\n  "include": ["src"]\n}\n',
        },
        {
          path: 'vite.config.ts',
          content:
            "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n",
        },
      ];
  return [
    ...bootstrap,
    { path: 'src/game.ts', content: gameSource },
    { path: 'src/App.tsx', content: appSource },
    { path: 'src/App.css', content: appCss },
    { path: 'src/index.css', content: indexCss },
    { path: 'tests/game.test.ts', content: testSource },
    { path: 'package.json', content: JSON.stringify(packageJson, null, 2) + '\n' },
  ];
}
