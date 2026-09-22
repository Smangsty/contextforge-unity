import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const serverJson = JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf8"));

const matchingPackages = (serverJson.packages ?? []).filter(
  (item) =>
    item?.registryType === "npm" &&
    item?.identifier === packageJson.name &&
    item?.version === packageJson.version &&
    item?.transport?.type === "stdio"
);

if (serverJson.version !== packageJson.version || matchingPackages.length !== 1) {
  throw new Error("package.json and server.json version/package identity are out of sync.");
}

const tag = process.env.GITHUB_REF_NAME;
if (typeof tag === "string" && tag.startsWith("v") && tag !== `v${packageJson.version}`) {
  throw new Error(`Release tag ${tag} does not match package version v${packageJson.version}.`);
}
