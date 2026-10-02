import { readText, scanFiles } from './workspace';

const NATIVE_FILES = /^(?:app\.(?:json|config\.[cm]?[jt]s)|expo-env\.d\.ts|ios\/[^/]+\/(?:Info\.plist|.*\.entitlements)|android\/app\/src\/main\/AndroidManifest\.xml)$/;

export async function inspectNativeProject(root: string, signal: AbortSignal) {
  const scan = await scanFiles(root, 10_000, signal);
  const files = scan.files.filter((file) => NATIVE_FILES.test(file));
  let manifest: Record<string, unknown> = {};
  try { manifest = JSON.parse(await readText(root, 'package.json')) as Record<string, unknown>; } catch {}
  const packages = { ...(manifest.dependencies as Record<string, string> | undefined), ...(manifest.devDependencies as Record<string, string> | undefined) };
  const configs: Record<string, string> = {};
  for (const file of files) {
    try { configs[file] = (await readText(root, file)).slice(0, 16_000); } catch {}
  }
  const configText = Object.values(configs).join('\n');
  const permissionTokens = [...configText.matchAll(/(?:android\.permission\.|NS[A-Za-z]+UsageDescription|permissions?["']?\s*[:=]\s*[\["'])[^\n,]*/g)]
    .map((item) => item[0].trim()).slice(0, 40);
  const navigationFiles = scan.files.filter((file) => /(?:^|\/)(?:app\/.*\.[jt]sx?|.*(?:Navigator|Navigation|routes?)\.[jt]sx?)$/.test(file)).slice(0, 60);
  return {
    runtime: packages.expo ? 'Expo' : packages['react-native'] ? 'React Native' : 'not detected',
    router: packages['expo-router'] ? 'Expo Router' : packages['@react-navigation/native'] ? 'React Navigation' : 'not detected',
    packages: ['expo', 'expo-router', 'react-native', '@react-navigation/native'].flatMap((name) => packages[name] ? [{ name, version: packages[name] }] : []),
    configFiles: Object.keys(configs),
    navigationFiles,
    permissionEvidence: permissionTokens,
    warnings: [
      ...(scan.complete ? [] : ['Workspace scan was partial; native configuration may be incomplete.']),
      ...(!files.length ? ['No app.json, app.config, AndroidManifest or Info.plist was indexed.'] : []),
    ],
    note: 'This is static configuration evidence. Read the relevant config and screen files before changing native permissions, schemes, plugins or navigation.',
  };
}
