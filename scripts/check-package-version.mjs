#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lockJson = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const packageVersion = String(packageJson.version || "");
const lockVersion = String(lockJson.version || "");
const rootPackageVersion = String(lockJson.packages?.[""]?.version || "");

if (!packageVersion || packageVersion !== lockVersion || packageVersion !== rootPackageVersion) {
	console.error(`Package version mismatch: package.json=${packageVersion || "missing"}, package-lock.json=${lockVersion || "missing"}, package-lock root=${rootPackageVersion || "missing"}`);
	process.exit(1);
}

console.log(`Package version synchronized: ${packageVersion}`);
