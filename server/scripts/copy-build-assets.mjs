import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");

for (const name of ["onboarding-assets", "built-ins"]) {
  const source = path.join(serverRoot, "src", name);
  const destination = path.join(serverRoot, "dist", name);
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}
