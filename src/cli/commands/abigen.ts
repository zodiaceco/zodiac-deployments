import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { format, resolveConfig } from "prettier";

import {
  defaultMastercopiesDir,
  listArtifacts,
  readArtifact,
} from "../artifact.js";
import { parseCliArgs } from "../args.js";

export async function run(args: string[]): Promise<void> {
  const { positionals } = parseCliArgs(args, []);
  if (positionals.length > 0) throw new Error("Usage: zodiac abigen");

  const count = await writeAbis();
  console.log(`  ✔ ${count} ABI export(s) written to ${DEFAULT_ABIS_DIR}`);
}

const DEFAULT_ABIS_DIR = path.join("src", "sdk", "abis");

const identifier = (v: string) => v.replace(/[^a-zA-Z0-9_$]/g, "_");

/**
 * Regenerate `src/sdk/abis` from the artifacts on disk: one module per
 * `name@version` exporting the main contract's ABI, plus an index of them all.
 */
async function writeAbis({
  mastercopiesDir = defaultMastercopiesDir(),
  abisDir = DEFAULT_ABIS_DIR,
}: {
  mastercopiesDir?: string;
  abisDir?: string;
} = {}): Promise<number> {
  if (!existsSync(mastercopiesDir)) {
    throw new Error(`no mastercopies folder at ${mastercopiesDir}`);
  }

  // Load everything before removing anything, so a bad artifact leaves the
  // existing exports alone.
  const abis = listArtifacts(mastercopiesDir).map(({ name, version }) => ({
    name,
    version,
    abi: readArtifact(name, version, mastercopiesDir)!.main.abi,
  }));

  const resolvedAbisDir = path.resolve(abisDir);
  const parentDir = path.dirname(resolvedAbisDir);
  const baseName = path.basename(resolvedAbisDir);
  const staging = path.join(parentDir, `.${baseName}.staging`);
  const previous = path.join(parentDir, `.${baseName}.previous`);

  rmSync(staging, { recursive: true, force: true });
  try {
    mkdirSync(staging, { recursive: true });

    const registry: Record<string, Record<string, string>> = {};

    for (const { name, version, abi } of abis) {
      const exportName = `${identifier(name)}_${version.replace(/\./g, "_")}_ABI`;

      mkdirSync(path.join(staging, name), { recursive: true });
      writeFileSync(
        path.join(staging, name, `${version}.ts`),
        `export const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`
      );

      (registry[name] ??= {})[version] = exportName;
    }

    const indexPath = path.join(resolvedAbisDir, "index.ts");
    const prettierConfig = await resolveConfig(indexPath);
    const index = await format(renderIndex(registry), {
      ...prettierConfig,
      filepath: indexPath,
    });
    writeFileSync(path.join(staging, "index.ts"), index);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  rmSync(previous, { recursive: true, force: true });
  const replacing = existsSync(resolvedAbisDir);
  if (replacing) renameSync(resolvedAbisDir, previous);
  try {
    renameSync(staging, resolvedAbisDir);
  } catch (error) {
    if (replacing) renameSync(previous, resolvedAbisDir);
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });

  return abis.length;
}

function renderIndex(registry: Record<string, Record<string, string>>) {
  const entries = Object.entries(registry);
  const imports = entries
    .flatMap(([mod, vers]) =>
      Object.entries(vers).map(
        ([ver, name]) => `import { ${name} } from "./${mod}/${ver}.js";`
      )
    )
    .join("\n");

  const body = entries
    .map(
      ([mod, vers]) =>
        `  ${JSON.stringify(mod)}: {\n${Object.entries(vers)
          .map(([ver, name]) => `    ${JSON.stringify(ver)}: ${name},`)
          .join("\n")}\n  },`
    )
    .join("\n");

  // `satisfies` keeps the literal ABI types while checking that the keys are
  // exactly the known contracts: none missing, none unknown.
  return [
    `import { MastercopyName } from "../contracts.js";`,
    imports,
    "",
    `export const ABIs = {\n${body}\n} as const satisfies Record<MastercopyName, Record<string, readonly unknown[]>>;`,
    "",
  ].join("\n");
}
