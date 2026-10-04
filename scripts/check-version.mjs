import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const serverJson = JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf8"));
const adapterSource = await readFile(
  new URL("../src/contextforge-unity.mjs", import.meta.url),
  "utf8"
);

const matchingPackages = (serverJson.packages ?? []).filter(
  (item) =>
    item?.registryType === "npm" &&
    item?.identifier === packageJson.name &&
    item?.version === packageJson.version &&
    item?.transport?.type === "stdio"
);

const adapterVersionMatch = adapterSource.match(
  /export const ADAPTER_VERSION = "([^"]+)";/
)?.[1];
const lockRootVersion = packageLock.packages?.[""]?.version;
const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});

if (
  serverJson.version !== packageJson.version ||
  packageLock.version !== packageJson.version ||
  lockRootVersion !== packageJson.version ||
  adapterVersionMatch !== packageJson.version ||
  matchingPackages.length !== 1 ||
  runtimeDependencies.length !== 0
) {
  throw new Error(
    "Package, lockfile, adapter, server manifest, or runtime dependency policy is out of sync."
  );
}

const tag = process.env.GITHUB_REF_NAME;
if (typeof tag === "string" && tag.startsWith("v") && tag !== "v" + packageJson.version) {
  throw new Error("Release tag " + tag + " does not match package version v" + packageJson.version + ".");
}
