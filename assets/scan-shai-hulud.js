#!/usr/bin/env node

/**
 * Shai Hulud 2 Package Scanner
 *
 * Scans a JavaScript repository for packages from the Shai Hulud 2 attack.
 * Checks for:
 * - Direct dependencies in package.json (npm, yarn, pnpm, bun)
 * - Dependencies in bower.json (Bower)
 * - Packages in lock files (package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb)
 * - Package manager config files (.npmrc, .yarnrc, pnpm-workspace.yaml, etc.)
 * - Potential installations via require/import statements
 *
 * Supports multiple package managers:
 * - npm (package.json, package-lock.json, .npmrc)
 * - yarn (package.json, yarn.lock, .yarnrc, .yarnrc.yml)
 * - pnpm (package.json, pnpm-lock.yaml, pnpm-workspace.yaml)
 * - bun (package.json, bun.lockb)
 * - bower (bower.json)
 * - Monorepo tools (lerna.json, rush.json, nx.json)
 *
 * Usage:
 *   Single repository: node scan-shai-hulud.js [directory]
 *   Batch mode: node scan-shai-hulud.js --batch [data-folder] [--report-dir report]
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const CSV_URL =
  "https://raw.githubusercontent.com/wiz-sec-public/wiz-research-iocs/main/reports/shai-hulud-2-packages.csv";

// Cache for malicious packages
let maliciousPackages = new Set();
let packageVersions = new Map();

/**
 * Fetch and parse the CSV file
 */
function fetchMaliciousPackages() {
  return new Promise((resolve, reject) => {
    console.log("Fetching malicious packages list...");
    https
      .get(CSV_URL, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            parseCSV(data);
            console.log(
              `Loaded ${maliciousPackages.size} malicious packages\n`
            );
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", (error) => {
        reject(error);
      });
  });
}

/**
 * Parse version string to extract actual version number
 * Handles formats like "= 1.0.1", "=1.0.1", "1.0.1", "= 1.0.1 || = 1.0.2"
 */
function parseMaliciousVersion(versionStr) {
  if (!versionStr) return null;

  // Remove leading "=" and whitespace
  const cleaned = versionStr.trim().replace(/^=\s*/, "");

  // Handle OR conditions (take first version)
  const orMatch = cleaned.match(/^(.+?)(?:\s*\|\|\s*|$)/);
  if (orMatch) {
    return orMatch[1].trim();
  }

  return cleaned;
}

/**
 * Parse CSV data and populate malicious packages set
 */
function parseCSV(csvData) {
  const lines = csvData.split("\n");

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse CSV line (handling quoted values)
    const match = line.match(/^"?(.+?)"?,\s*"?(.+?)"?$/);
    if (match) {
      const packageName = match[1].trim();
      const version = match[2].trim();

      if (packageName && packageName !== "Package") {
        maliciousPackages.add(packageName);
        if (version && version !== "Version") {
          const parsedVersion = parseMaliciousVersion(version);
          if (parsedVersion) {
            packageVersions.set(packageName, parsedVersion);
          }
        }
      }
    }
  }
}

/**
 * Recursively find all files matching a pattern
 */
function findFiles(dir, pattern, fileList = []) {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      // Skip node_modules, .git, and other common directories
      if (
        !["node_modules", ".git", ".next", "dist", "build", ".cache"].includes(
          file
        )
      ) {
        try {
          findFiles(filePath, pattern, fileList);
        } catch (err) {
          // Skip directories we can't read
        }
      }
    } else if (pattern.test(file)) {
      fileList.push(filePath);
    }
  }

  return fileList;
}

/**
 * Parse semantic version string to components
 */
function parseVersion(version) {
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+([\w.-]+))?$/
  );
  if (!match) return null;

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
    build: match[5] || null,
  };
}

/**
 * Compare two version objects
 * Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
function compareVersions(v1, v2) {
  if (v1.major !== v2.major) return v1.major - v2.major;
  if (v1.minor !== v2.minor) return v1.minor - v2.minor;
  if (v1.patch !== v2.patch) return v1.patch - v2.patch;

  // Handle prerelease versions (simplified - prerelease < release)
  if (v1.prerelease && !v2.prerelease) return -1;
  if (!v1.prerelease && v2.prerelease) return 1;
  if (v1.prerelease && v2.prerelease) {
    return v1.prerelease.localeCompare(v2.prerelease);
  }

  return 0;
}

/**
 * Check if a version satisfies a range
 * Supports: exact, ^, ~, >=, <=, >, <, -, ||, x, *, latest
 */
function versionSatisfies(versionRange, targetVersion) {
  if (!versionRange || !targetVersion) return false;

  const target = parseVersion(targetVersion);
  if (!target) return false;

  // Normalize version range
  const range = versionRange.trim();

  // Exact match
  if (range === targetVersion || range === "*" || range === "latest") {
    return true;
  }

  // Handle OR conditions (||)
  if (range.includes("||")) {
    return range
      .split("||")
      .some((r) => versionSatisfies(r.trim(), targetVersion));
  }

  // Handle ranges with spaces (e.g., "1.0.0 - 1.0.2")
  if (range.includes(" - ")) {
    const [min, max] = range.split(" - ").map((v) => v.trim());
    const minVer = parseVersion(min);
    const maxVer = parseVersion(max);
    if (minVer && maxVer) {
      return (
        compareVersions(target, minVer) >= 0 &&
        compareVersions(target, maxVer) <= 0
      );
    }
  }

  // Handle >= <= > < operators
  const operatorMatch = range.match(/^(>=|<=|>|<)\s*(.+)$/);
  if (operatorMatch) {
    const [, op, version] = operatorMatch;
    const ver = parseVersion(version);
    if (!ver) return false;

    const cmp = compareVersions(target, ver);
    switch (op) {
      case ">=":
        return cmp >= 0;
      case "<=":
        return cmp <= 0;
      case ">":
        return cmp > 0;
      case "<":
        return cmp < 0;
    }
  }

  // Handle caret ranges (^1.0.0 allows >=1.0.0 <2.0.0)
  if (range.startsWith("^")) {
    const baseVersion = range.substring(1).trim();
    const base = parseVersion(baseVersion);
    if (!base) return false;

    // ^1.0.0 allows >=1.0.0 <2.0.0
    // ^0.1.0 allows >=0.1.0 <0.2.0
    // ^0.0.1 allows >=0.0.1 <0.0.2
    if (base.major > 0) {
      return compareVersions(target, base) >= 0 && target.major === base.major;
    } else if (base.minor > 0) {
      return (
        compareVersions(target, base) >= 0 &&
        target.major === 0 &&
        target.minor === base.minor
      );
    } else {
      return (
        compareVersions(target, base) >= 0 &&
        target.major === 0 &&
        target.minor === 0 &&
        target.patch === base.patch
      );
    }
  }

  // Handle tilde ranges (~1.0.0 allows >=1.0.0 <1.1.0)
  if (range.startsWith("~")) {
    const baseVersion = range.substring(1).trim();
    const base = parseVersion(baseVersion);
    if (!base) return false;

    // ~1.0.0 allows >=1.0.0 <1.1.0
    // ~1.2.3 allows >=1.2.3 <1.3.0
    return (
      compareVersions(target, base) >= 0 &&
      target.major === base.major &&
      target.minor === base.minor
    );
  }

  // Handle wildcards (1.0.x, 1.x, x)
  if (range.includes("x") || range.includes("*")) {
    const normalized = range.replace(/\*/g, "x");
    const parts = normalized.split(".");

    if (parts.length === 1 && parts[0] === "x") {
      return true; // * matches any version
    }

    // Match major.minor.patch patterns
    const majorMatch =
      parts[0] === "x" ||
      parts[0] === "*" ||
      parseInt(parts[0], 10) === target.major;
    const minorMatch =
      parts.length < 2 ||
      parts[1] === "x" ||
      parts[1] === "*" ||
      parseInt(parts[1], 10) === target.minor;
    const patchMatch =
      parts.length < 3 ||
      parts[2] === "x" ||
      parts[2] === "*" ||
      parseInt(parts[2], 10) === target.patch;

    return majorMatch && minorMatch && patchMatch;
  }

  // Handle URL/file paths (not a version range)
  if (
    range.startsWith("http://") ||
    range.startsWith("https://") ||
    range.startsWith("file:") ||
    range.startsWith("git+")
  ) {
    return false;
  }

  // Try exact match after removing any leading operators
  const exactMatch = range.replace(/^(>=|<=|>|<|~|\^|=)\s*/, "");
  const exact = parseVersion(exactMatch);
  if (exact) {
    return compareVersions(target, exact) === 0;
  }

  return false;
}

/**
 * Check if a version range could include a malicious version
 */
function couldIncludeMaliciousVersion(versionRange, maliciousVersion) {
  if (!versionRange || !maliciousVersion) {
    // If no malicious version specified, any match is suspicious
    return true;
  }

  return versionSatisfies(versionRange, maliciousVersion);
}

/**
 * Check package.json for malicious packages
 */
function checkPackageJson(filePath) {
  const findings = [];

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const pkg = JSON.parse(content);

    const checkDeps = (deps, type) => {
      if (!deps) return;

      for (const [pkgName, versionRange] of Object.entries(deps)) {
        if (maliciousPackages.has(pkgName)) {
          const maliciousVersion = packageVersions.get(pkgName);
          const isVulnerable = couldIncludeMaliciousVersion(
            versionRange,
            maliciousVersion
          );

          if (isVulnerable) {
            findings.push({
              type: "package.json",
              location: filePath,
              package: pkgName,
              version: versionRange,
              dependencyType: type,
              severity: "HIGH",
              maliciousVersion: maliciousVersion || "unknown",
              note: maliciousVersion
                ? `Version range "${versionRange}" could include malicious version ${maliciousVersion}`
                : `Package is in malicious packages list`,
            });
          } else if (maliciousVersion) {
            // Name matches but version range appears safe - INFO level
            findings.push({
              type: "package.json",
              location: filePath,
              package: pkgName,
              version: versionRange,
              dependencyType: type,
              severity: "INFO",
              maliciousVersion: maliciousVersion,
              note: `Package name matches malicious package, but version range "${versionRange}" appears safe (malicious version: ${maliciousVersion})`,
            });
          } else {
            // Name matches but no version info - INFO level
            findings.push({
              type: "package.json",
              location: filePath,
              package: pkgName,
              version: versionRange,
              dependencyType: type,
              severity: "INFO",
              note: `Package name matches malicious package list (no version information available)`,
            });
          }
        }
      }
    };

    // Standard dependency fields
    checkDeps(pkg.dependencies, "dependencies");
    checkDeps(pkg.devDependencies, "devDependencies");
    checkDeps(pkg.peerDependencies, "peerDependencies");
    checkDeps(pkg.optionalDependencies, "optionalDependencies");

    // Yarn resolutions (force specific versions)
    checkDeps(pkg.resolutions, "resolutions");

    // npm overrides (force specific versions)
    checkDeps(pkg.overrides, "overrides");

    // pnpm overrides
    if (pkg.pnpm && pkg.pnpm.overrides) {
      checkDeps(pkg.pnpm.overrides, "pnpm.overrides");
    }

    // Workspace packages (monorepos)
    if (pkg.workspaces) {
      // Workspaces can be an array of paths or an object
      // We check the workspace packages themselves via recursive scanning
    }
  } catch (error) {
    // Invalid JSON or can't read file
  }

  return findings;
}

/**
 * Check lock files for malicious packages
 */
function checkLockFile(filePath) {
  const findings = [];
  const lockType = path.basename(filePath);
  const isBinary = lockType.endsWith(".lockb");

  try {
    let content;

    if (isBinary) {
      // For binary lock files (e.g., bun.lockb), try to read as text
      // This may not work perfectly but can catch some patterns
      try {
        const buffer = fs.readFileSync(filePath);
        // Try to find package names in the binary data
        content = buffer.toString(
          "utf8",
          0,
          Math.min(buffer.length, 10 * 1024 * 1024)
        ); // First 10MB
      } catch (err) {
        // If we can't read it, skip binary lock files
        return findings;
      }
    } else {
      content = fs.readFileSync(filePath, "utf8");
    }

    for (const pkgName of maliciousPackages) {
      // Check for package name in lock file
      // This is a simple check - actual parsing would be more complex
      const escapedName = pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const patterns = [
        // JSON format (package-lock.json, yarn.lock entries)
        new RegExp(`"${escapedName}"\\s*:`, "g"),
        new RegExp(`"${escapedName}"\\s*=`, "g"),
        // URL format (yarn.lock, pnpm-lock.yaml)
        new RegExp(`/${escapedName}@`, "g"),
        // Yarn v2+ format
        new RegExp(`${escapedName}@npm:`, "g"),
        // pnpm format variations
        new RegExp(`/${escapedName}/`, "g"),
        // Bun format (in binary, may appear as text)
        new RegExp(`"name":\\s*"${escapedName}"`, "g"),
      ];

      for (const pattern of patterns) {
        if (pattern.test(content)) {
          findings.push({
            type: lockType,
            location: filePath,
            package: pkgName,
            severity: "MEDIUM",
            note: isBinary
              ? "Found in binary lock file - may be installed via dependency"
              : "Found in lock file - may be installed via dependency",
          });
          break; // Found it, no need to check other patterns
        }
      }
    }
  } catch (error) {
    // Can't read file
  }

  return findings;
}

/**
 * Check source code files for require/import statements
 */
function checkSourceFile(filePath) {
  const findings = [];

  try {
    const content = fs.readFileSync(filePath, "utf8");

    for (const pkgName of maliciousPackages) {
      // Check for require statements
      const requirePattern = new RegExp(
        `require\\s*\\(\\s*['"]${pkgName.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        )}['"]\\s*\\)`,
        "g"
      );

      // Check for import statements
      const importPatterns = [
        new RegExp(
          `import\\s+.*\\s+from\\s+['"]${pkgName.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
          )}['"]`,
          "g"
        ),
        new RegExp(
          `import\\s*['"]${pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`,
          "g"
        ),
        new RegExp(
          `from\\s+['"]${pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`,
          "g"
        ),
      ];

      if (requirePattern.test(content)) {
        findings.push({
          type: "source_code",
          location: filePath,
          package: pkgName,
          severity: "MEDIUM",
          note: "Found require() statement",
        });
      }

      for (const pattern of importPatterns) {
        if (pattern.test(content)) {
          findings.push({
            type: "source_code",
            location: filePath,
            package: pkgName,
            severity: "MEDIUM",
            note: "Found import statement",
          });
          break;
        }
      }
    }
  } catch (error) {
    // Can't read file
  }

  return findings;
}

/**
 * Check bower.json for malicious packages
 */
function checkBowerJson(filePath) {
  const findings = [];

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const bower = JSON.parse(content);

    const checkDeps = (deps, type) => {
      if (!deps) return;

      for (const [pkgName, versionRange] of Object.entries(deps)) {
        if (maliciousPackages.has(pkgName)) {
          const maliciousVersion = packageVersions.get(pkgName);
          const isVulnerable = couldIncludeMaliciousVersion(
            versionRange,
            maliciousVersion
          );

          if (isVulnerable) {
            findings.push({
              type: "bower.json",
              location: filePath,
              package: pkgName,
              version: versionRange,
              dependencyType: type,
              severity: "HIGH",
              maliciousVersion: maliciousVersion || "unknown",
              note: maliciousVersion
                ? `Version range "${versionRange}" could include malicious version ${maliciousVersion}`
                : `Package is in malicious packages list`,
            });
          } else if (maliciousVersion) {
            // Name matches but version range appears safe - INFO level
            findings.push({
              type: "bower.json",
              location: filePath,
              package: pkgName,
              version: versionRange,
              dependencyType: type,
              severity: "INFO",
              maliciousVersion: maliciousVersion,
              note: `Package name matches malicious package, but version range "${versionRange}" appears safe (malicious version: ${maliciousVersion})`,
            });
          } else {
            // Name matches but no version info - INFO level
            findings.push({
              type: "bower.json",
              location: filePath,
              package: pkgName,
              version: versionRange,
              dependencyType: type,
              severity: "INFO",
              note: `Package name matches malicious package list (no version information available)`,
            });
          }
        }
      }
    };

    checkDeps(bower.dependencies, "dependencies");
    checkDeps(bower.devDependencies, "devDependencies");
    checkDeps(bower.resolutions, "resolutions");
  } catch (error) {
    // Invalid JSON or can't read file
  }

  return findings;
}

/**
 * Check configuration files for package references
 */
function checkConfigFile(filePath) {
  const findings = [];
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath);

  try {
    const content = fs.readFileSync(filePath, "utf8");

    // Check for package names in config files
    // This is a simple pattern match - may have false positives
    for (const pkgName of maliciousPackages) {
      const escapedName = pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // Common patterns in config files
      const patterns = [
        new RegExp(`"${escapedName}"`, "g"),
        new RegExp(`'${escapedName}'`, "g"),
        new RegExp(`\\b${escapedName}\\b`, "g"),
      ];

      for (const pattern of patterns) {
        if (pattern.test(content)) {
          findings.push({
            type: fileName,
            location: filePath,
            package: pkgName,
            severity: "LOW",
            note: `Found reference in ${fileName} config file`,
          });
          break;
        }
      }
    }
  } catch (error) {
    // Can't read file
  }

  return findings;
}

/**
 * Check GitHub Actions workflow files for npm i instead of npm ci
 */
function checkWorkflowFile(filePath) {
  const findings = [];

  try {
    const content = fs.readFileSync(filePath, "utf8");

    // Patterns to detect npm install (but not npm ci)
    // Match: npm i, npm install, npm install --..., RUN npm i, RUN npm install
    // But exclude: npm ci, npm ci --..., RUN npm ci
    const npmInstallPatterns = [
      // Direct npm i (but not npm ci)
      /\bnpm\s+[iI](?!\s+ci\b)/g,
      // Direct npm install (but not npm ci)
      /\bnpm\s+install(?!\s+--ci\b)/g,
      // In YAML run steps (GitHub Actions format)
      /run:\s*.*\bnpm\s+[iI](?!\s+ci\b)/gi,
      /run:\s*.*\bnpm\s+install(?!\s+--ci\b)/gi,
      // In shell script blocks
      /-.*\bnpm\s+[iI](?!\s+ci\b)/g,
      /-.*\bnpm\s+install(?!\s+--ci\b)/g,
    ];

    for (const pattern of npmInstallPatterns) {
      if (pattern.test(content)) {
        findings.push({
          type: "github_workflow",
          location: filePath,
          severity: "MEDIUM",
          note: "Uses 'npm i' or 'npm install' instead of 'npm ci'. Consider using 'npm ci' for deterministic, reproducible builds.",
        });
        break; // Found it, no need to check other patterns
      }
    }
  } catch (error) {
    // Can't read file
  }

  return findings;
}

/**
 * Check Dockerfiles for npm i instead of npm ci
 */
function checkDockerfile(filePath) {
  const findings = [];

  try {
    let content = fs.readFileSync(filePath, "utf8");

    // Normalize multi-line RUN commands by joining continuation lines
    // This handles cases where npm i is on a line after a backslash continuation
    const lines = content.split("\n");
    const normalizedLines = [];
    let currentRunCommand = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      const lineEndsWithBackslash = /\\\s*$/.test(trimmedLine);

      // Check if this is a RUN command
      if (trimmedLine.startsWith("RUN ")) {
        // If we have a previous RUN command, add it (remove trailing backslash)
        if (currentRunCommand !== null) {
          const cleanedCommand = currentRunCommand.replace(/\\\s*$/, "").trim();
          normalizedLines.push(cleanedCommand);
        }
        // Start a new RUN command, remove trailing backslash if present
        currentRunCommand = trimmedLine.replace(/\\\s*$/, "").trim();
        // If it doesn't end with backslash, it's a single-line RUN command
        if (!lineEndsWithBackslash) {
          normalizedLines.push(currentRunCommand);
          currentRunCommand = null;
        }
      } else if (currentRunCommand !== null) {
        // This is a continuation of the RUN command
        // Remove leading/trailing backslashes and whitespace
        const cleanLine = trimmedLine
          .replace(/^\\\s*/, "")
          .replace(/\\\s*$/, "")
          .trim();
        if (cleanLine) {
          currentRunCommand += " " + cleanLine;
        }
        // If line doesn't end with backslash, the RUN command is complete
        if (!lineEndsWithBackslash) {
          normalizedLines.push(currentRunCommand);
          currentRunCommand = null;
        }
      } else {
        // Regular line, not part of a RUN command
        normalizedLines.push(line);
      }
    }

    // Add any remaining RUN command (remove trailing backslash)
    if (currentRunCommand !== null) {
      const cleanedCommand = currentRunCommand.replace(/\\\s*$/, "").trim();
      normalizedLines.push(cleanedCommand);
    }

    // Join normalized lines back together
    content = normalizedLines.join("\n");

    // Patterns to detect npm install (but not npm ci)
    // Match: RUN npm i, RUN npm install, RUN npm install --...
    // But exclude: RUN npm ci, RUN npm ci --...
    const npmInstallPatterns = [
      // RUN npm i (but not RUN npm ci) - handles multi-line commands
      /RUN\s+.*\bnpm\s+[iI](?!\s+ci\b)/g,
      // RUN npm install (but not RUN npm ci) - handles multi-line commands
      /RUN\s+.*\bnpm\s+install(?!\s+--ci\b)/g,
      // Also check for standalone npm i/install (in case it's not in a RUN command)
      /\bnpm\s+[iI](?!\s+ci\b)/g,
      /\bnpm\s+install(?!\s+--ci\b)/g,
    ];

    for (const pattern of npmInstallPatterns) {
      if (pattern.test(content)) {
        findings.push({
          type: "dockerfile",
          location: filePath,
          severity: "MEDIUM",
          note: "Uses 'npm i' or 'npm install' instead of 'npm ci'. Consider using 'npm ci' for deterministic, reproducible builds.",
        });
        break; // Found it, no need to check other patterns
      }
    }
  } catch (error) {
    // Can't read file
  }

  return findings;
}

/**
 * Main scanning function
 */
function scanRepository(rootDir) {
  console.log(`Scanning repository: ${rootDir}\n`);

  const allFindings = [];

  // Check package.json files (npm, yarn, pnpm, bun all use this)
  console.log("Checking package.json files...");
  const packageJsonFiles = findFiles(rootDir, /^package\.json$/);
  for (const file of packageJsonFiles) {
    const findings = checkPackageJson(file);
    allFindings.push(...findings);
  }

  // Check bower.json files (Bower package manager)
  console.log("Checking bower.json files...");
  const bowerJsonFiles = findFiles(rootDir, /^bower\.json$/);
  for (const file of bowerJsonFiles) {
    const findings = checkBowerJson(file);
    allFindings.push(...findings);
  }

  // Check lock files (all package managers)
  console.log("Checking lock files...");
  const lockFiles = findFiles(
    rootDir,
    /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|yarn\.lockb)$/
  );
  for (const file of lockFiles) {
    const findings = checkLockFile(file);
    allFindings.push(...findings);
  }

  // Check package manager config files
  console.log("Checking package manager config files...");
  const configFiles = findFiles(
    rootDir,
    /^(\.npmrc|\.yarnrc|\.yarnrc\.yml|pnpm-workspace\.yaml|lerna\.json|rush\.json|nx\.json|jspm\.config\.js|component\.json)$/
  );
  for (const file of configFiles) {
    const findings = checkConfigFile(file);
    allFindings.push(...findings);
  }

  // Check source code files
  console.log("Checking source code files...");
  const sourceFiles = findFiles(rootDir, /\.(js|jsx|ts|tsx|mjs|cjs)$/);
  for (const file of sourceFiles) {
    const findings = checkSourceFile(file);
    allFindings.push(...findings);
  }

  // Check GitHub Actions workflow files
  console.log("Checking GitHub Actions workflow files...");
  const allYamlFiles = findFiles(rootDir, /\.(yml|yaml)$/);
  const workflowFiles = allYamlFiles.filter((file) =>
    file.includes(".github/workflows/")
  );
  for (const file of workflowFiles) {
    const findings = checkWorkflowFile(file);
    allFindings.push(...findings);
  }

  // Check Dockerfiles
  console.log("Checking Dockerfiles...");
  // Find files named "Dockerfile" or with .dockerfile extension
  // Note: findFiles matches against filename only, so we need to check multiple patterns
  const dockerfiles = [];
  const dockerfilePatterns = [/^Dockerfile$/, /^Dockerfile\./, /\.dockerfile$/];
  for (const pattern of dockerfilePatterns) {
    const files = findFiles(rootDir, pattern);
    for (const file of files) {
      if (!dockerfiles.includes(file)) {
        dockerfiles.push(file);
      }
    }
  }
  for (const file of dockerfiles) {
    const findings = checkDockerfile(file);
    allFindings.push(...findings);
  }

  return allFindings;
}

/**
 * Format and display results
 */
function displayResults(findings) {
  console.log("\n" + "=".repeat(80));
  console.log("SCAN RESULTS");
  console.log("=".repeat(80) + "\n");

  if (findings.length === 0) {
    console.log("✓ No malicious packages found.\n");
    return;
  }

  // Group by severity
  const high = findings.filter((f) => f.severity === "HIGH");
  const medium = findings.filter((f) => f.severity === "MEDIUM");
  const low = findings.filter((f) => f.severity === "LOW");
  const info = findings.filter((f) => f.severity === "INFO");

  const criticalCount = high.length + medium.length + low.length;
  if (criticalCount > 0) {
    console.log(
      `⚠️  Found ${criticalCount} potential issue(s) and ${info.length} informational finding(s):\n`
    );
  } else if (info.length > 0) {
    console.log(`ℹ️  Found ${info.length} informational finding(s):\n`);
  } else {
    console.log(`⚠️  Found ${findings.length} potential issue(s):\n`);
  }

  if (high.length > 0) {
    console.log(`🔴 HIGH SEVERITY (${high.length}):`);
    console.log("   Direct dependencies in package files\n");
    for (const finding of high) {
      console.log(`   Package: ${finding.package}`);
      console.log(`   Location: ${finding.location}`);
      console.log(`   Type: ${finding.dependencyType || finding.type}`);
      if (finding.version) {
        console.log(`   Version Range: ${finding.version}`);
      }
      if (finding.maliciousVersion) {
        console.log(`   Malicious Version: ${finding.maliciousVersion}`);
      } else if (packageVersions.has(finding.package)) {
        console.log(
          `   Known malicious version: ${packageVersions.get(finding.package)}`
        );
      }
      if (finding.note) {
        console.log(`   Note: ${finding.note}`);
      }
      console.log("");
    }
  }

  if (medium.length > 0) {
    console.log(`🟡 MEDIUM SEVERITY (${medium.length}):`);
    console.log("   Found in lock files, source code, or build files\n");
    for (const finding of medium) {
      if (finding.package) {
        console.log(`   Package: ${finding.package}`);
      }
      console.log(`   Location: ${finding.location}`);
      console.log(
        `   Type: ${finding.type || finding.dependencyType || "unknown"}`
      );
      if (finding.note) {
        console.log(`   Note: ${finding.note}`);
      }
      console.log("");
    }
  }

  if (low.length > 0) {
    console.log(`🟢 LOW SEVERITY (${low.length}):`);
    console.log("   Found in config files (may be false positive)\n");
    for (const finding of low) {
      if (finding.package) {
        console.log(`   Package: ${finding.package}`);
      }
      console.log(`   Location: ${finding.location}`);
      console.log(
        `   Type: ${finding.type || finding.dependencyType || "unknown"}`
      );
      if (finding.note) {
        console.log(`   Note: ${finding.note}`);
      }
      console.log("");
    }
  }

  if (info.length > 0) {
    console.log(`ℹ️  INFO (${info.length}):`);
    console.log("   Package name matches but version range appears safe\n");
    for (const finding of info) {
      console.log(`   Package: ${finding.package}`);
      console.log(`   Location: ${finding.location}`);
      console.log(`   Type: ${finding.dependencyType || finding.type}`);
      if (finding.version) {
        console.log(`   Version Range: ${finding.version}`);
      }
      if (finding.maliciousVersion) {
        console.log(`   Malicious Version: ${finding.maliciousVersion}`);
      }
      if (finding.note) {
        console.log(`   Note: ${finding.note}`);
      }
      console.log("");
    }
  }

  // Summary
  console.log("=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));
  console.log(`Total findings: ${findings.length}`);
  console.log(`High severity: ${high.length}`);
  console.log(`Medium severity: ${medium.length}`);
  console.log(`Low severity: ${low.length}`);
  console.log(`Info: ${info.length}`);
  console.log(
    `Unique packages: ${new Set(findings.map((f) => f.package)).size}`
  );
  console.log("");
}

/**
 * Format findings as text for report
 */
function formatFindingsAsText(findings, repositoryPath) {
  const lines = [];

  lines.push("=".repeat(80));
  lines.push(`REPOSITORY: ${repositoryPath}`);
  lines.push("=".repeat(80));
  lines.push("");

  if (findings.length === 0) {
    lines.push("✓ No malicious packages found.");
    lines.push("");
    return lines.join("\n");
  }

  // Group by severity
  const high = findings.filter((f) => f.severity === "HIGH");
  const medium = findings.filter((f) => f.severity === "MEDIUM");
  const low = findings.filter((f) => f.severity === "LOW");
  const info = findings.filter((f) => f.severity === "INFO");

  const criticalCount = high.length + medium.length + low.length;
  if (criticalCount > 0) {
    lines.push(
      `⚠️  Found ${criticalCount} potential issue(s) and ${info.length} informational finding(s):`
    );
  } else if (info.length > 0) {
    lines.push(`ℹ️  Found ${info.length} informational finding(s):`);
  } else {
    lines.push(`⚠️  Found ${findings.length} potential issue(s):`);
  }
  lines.push("");

  if (high.length > 0) {
    lines.push(`🔴 HIGH SEVERITY (${high.length}):`);
    lines.push("   Direct dependencies in package files");
    lines.push("");
    for (const finding of high) {
      lines.push(`   Package: ${finding.package || "N/A"}`);
      lines.push(`   Location: ${finding.location}`);
      lines.push(
        `   Type: ${finding.dependencyType || finding.type || "unknown"}`
      );
      if (finding.version) {
        lines.push(`   Version Range: ${finding.version}`);
      }
      if (finding.maliciousVersion) {
        lines.push(`   Malicious Version: ${finding.maliciousVersion}`);
      } else if (finding.package && packageVersions.has(finding.package)) {
        lines.push(
          `   Known malicious version: ${packageVersions.get(finding.package)}`
        );
      }
      if (finding.note) {
        lines.push(`   Note: ${finding.note}`);
      }
      lines.push("");
    }
  }

  if (medium.length > 0) {
    lines.push(`🟡 MEDIUM SEVERITY (${medium.length}):`);
    lines.push("   Found in lock files, source code, or build files");
    lines.push("");
    for (const finding of medium) {
      if (finding.package) {
        lines.push(`   Package: ${finding.package}`);
      }
      lines.push(`   Location: ${finding.location}`);
      lines.push(
        `   Type: ${finding.type || finding.dependencyType || "unknown"}`
      );
      if (finding.note) {
        lines.push(`   Note: ${finding.note}`);
      }
      lines.push("");
    }
  }

  if (low.length > 0) {
    lines.push(`🟢 LOW SEVERITY (${low.length}):`);
    lines.push("   Found in config files (may be false positive)");
    lines.push("");
    for (const finding of low) {
      if (finding.package) {
        lines.push(`   Package: ${finding.package}`);
      }
      lines.push(`   Location: ${finding.location}`);
      lines.push(
        `   Type: ${finding.type || finding.dependencyType || "unknown"}`
      );
      if (finding.note) {
        lines.push(`   Note: ${finding.note}`);
      }
      lines.push("");
    }
  }

  if (info.length > 0) {
    lines.push(`ℹ️  INFO (${info.length}):`);
    lines.push("   Package name matches but version range appears safe");
    lines.push("");
    for (const finding of info) {
      lines.push(`   Package: ${finding.package || "N/A"}`);
      lines.push(`   Location: ${finding.location}`);
      lines.push(
        `   Type: ${finding.dependencyType || finding.type || "unknown"}`
      );
      if (finding.version) {
        lines.push(`   Version Range: ${finding.version}`);
      }
      if (finding.maliciousVersion) {
        lines.push(`   Malicious Version: ${finding.maliciousVersion}`);
      }
      if (finding.note) {
        lines.push(`   Note: ${finding.note}`);
      }
      lines.push("");
    }
  }

  // Summary
  lines.push("=".repeat(80));
  lines.push("SUMMARY");
  lines.push("=".repeat(80));
  lines.push(`Total findings: ${findings.length}`);
  lines.push(`High severity: ${high.length}`);
  lines.push(`Medium severity: ${medium.length}`);
  lines.push(`Low severity: ${low.length}`);
  lines.push(`Info: ${info.length}`);
  lines.push(
    `Unique packages: ${
      new Set(findings.map((f) => f.package).filter(Boolean)).size
    }`
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Batch process multiple repositories in a data folder
 */
async function batchProcess(dataFolder, reportDir) {
  console.log(`Batch processing repositories in: ${dataFolder}\n`);

  // Create report directory if it doesn't exist
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  // Fetch malicious packages list once
  await fetchMaliciousPackages();

  // Get all subdirectories in data folder
  const entries = fs.readdirSync(dataFolder, { withFileTypes: true });
  const repositories = entries
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => path.join(dataFolder, dirent.name));

  if (repositories.length === 0) {
    console.log("No repositories found in data folder.");
    return;
  }

  console.log(`Found ${repositories.length} repository(ies) to scan.\n`);

  const allReports = [];
  const summary = {
    total: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    repositories: [],
  };

  // Process each repository
  for (let i = 0; i < repositories.length; i++) {
    const repoPath = repositories[i];
    const repoName = path.basename(repoPath);

    console.log(`[${i + 1}/${repositories.length}] Scanning: ${repoName}`);

    try {
      const findings = scanRepository(repoPath);

      // Update summary
      summary.total += findings.length;
      summary.high += findings.filter((f) => f.severity === "HIGH").length;
      summary.medium += findings.filter((f) => f.severity === "MEDIUM").length;
      summary.low += findings.filter((f) => f.severity === "LOW").length;
      summary.info += findings.filter((f) => f.severity === "INFO").length;
      summary.repositories.push({
        name: repoName,
        path: repoPath,
        findings: findings.length,
        critical: findings.filter(
          (f) =>
            f.severity === "HIGH" ||
            f.severity === "MEDIUM" ||
            f.severity === "LOW"
        ).length,
      });

      // Format findings for report
      const reportText = formatFindingsAsText(findings, repoPath);
      allReports.push(reportText);

      // Generate individual report file for this repository
      // Sanitize repository name for filename (remove invalid characters)
      const sanitizedRepoName = repoName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const individualReportPath = path.join(
        reportDir,
        `${sanitizedRepoName}_report.txt`
      );
      const individualReportContent = [
        "SHAI HULUD 2 PACKAGE SCANNER - INDIVIDUAL REPORT",
        "=".repeat(80),
        `Generated: ${new Date().toISOString()}`,
        `Repository: ${repoName}`,
        `Path: ${repoPath}`,
        "",
        reportText,
      ].join("\n");

      fs.writeFileSync(individualReportPath, individualReportContent, "utf8");
      console.log(`   Found ${findings.length} finding(s)`);
      console.log(`   Report saved: ${individualReportPath}\n`);
    } catch (error) {
      console.error(`   Error scanning ${repoName}: ${error.message}\n`);
      const errorReport = `\n${"=".repeat(
        80
      )}\nREPOSITORY: ${repoPath}\n${"=".repeat(80)}\n\n❌ Error: ${
        error.message
      }\n`;
      allReports.push(errorReport);

      // Also write error report to individual file
      const sanitizedRepoName = repoName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const individualReportPath = path.join(
        reportDir,
        `${sanitizedRepoName}_report.txt`
      );
      const errorReportContent = [
        "SHAI HULUD 2 PACKAGE SCANNER - INDIVIDUAL REPORT",
        "=".repeat(80),
        `Generated: ${new Date().toISOString()}`,
        `Repository: ${repoName}`,
        `Path: ${repoPath}`,
        "",
        errorReport,
      ].join("\n");
      fs.writeFileSync(individualReportPath, errorReportContent, "utf8");
    }
  }

  // Generate consolidated report
  const reportPath = path.join(reportDir, "report.txt");
  const reportContent = [
    "SHAI HULUD 2 PACKAGE SCANNER - BATCH REPORT",
    "=".repeat(80),
    `Generated: ${new Date().toISOString()}`,
    `Total Repositories Scanned: ${repositories.length}`,
    "",
    "OVERALL SUMMARY",
    "=".repeat(80),
    `Total findings across all repositories: ${summary.total}`,
    `High severity: ${summary.high}`,
    `Medium severity: ${summary.medium}`,
    `Low severity: ${summary.low}`,
    `Info: ${summary.info}`,
    "",
    "REPOSITORY SUMMARY",
    "=".repeat(80),
    ...summary.repositories.map(
      (repo) =>
        `  ${repo.name}: ${repo.findings} finding(s) (${repo.critical} critical)`
    ),
    "",
    "=".repeat(80),
    "DETAILED REPORTS",
    "=".repeat(80),
    "",
    ...allReports,
  ].join("\n");

  // Write consolidated report to file
  fs.writeFileSync(reportPath, reportContent, "utf8");
  console.log(`\nConsolidated report written to: ${reportPath}`);
  console.log(`Individual reports written to: ${reportDir}/`);
  console.log(`\nSummary:`);
  console.log(`  Total repositories: ${repositories.length}`);
  console.log(`  Total findings: ${summary.total}`);
  console.log(
    `  Critical findings: ${summary.high + summary.medium + summary.low}`
  );
  console.log(`  Individual reports: ${repositories.length} file(s)`);
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Check for batch mode flag
  const batchIndex = args.findIndex((arg) => arg === "--batch" || arg === "-b");
  const reportDirIndex = args.findIndex(
    (arg) => arg === "--report-dir" || arg === "-r"
  );

  // Batch mode
  if (batchIndex !== -1) {
    const dataFolder = args[batchIndex + 1] || "data";
    const reportDir =
      reportDirIndex !== -1 ? args[reportDirIndex + 1] || "report" : "report";

    const dataPath = path.resolve(dataFolder);
    const reportPath = path.resolve(reportDir);

    if (!fs.existsSync(dataPath)) {
      console.error(`Error: Data folder does not exist: ${dataPath}`);
      process.exit(1);
    }

    try {
      await batchProcess(dataPath, reportPath);
    } catch (error) {
      console.error("Error:", error.message);
      process.exit(1);
    }
    return;
  }

  // Single repository mode
  const rootDir = args[0] || process.cwd();

  if (!fs.existsSync(rootDir)) {
    console.error(`Error: Directory does not exist: ${rootDir}`);
    process.exit(1);
  }

  try {
    // Fetch malicious packages list
    await fetchMaliciousPackages();

    // Scan repository
    const findings = scanRepository(rootDir);

    // Display results
    displayResults(findings);

    // Exit with error code if critical findings found (HIGH, MEDIUM, LOW)
    // INFO findings are informational only and don't cause exit code 1
    const criticalFindings = findings.filter(
      (f) =>
        f.severity === "HIGH" || f.severity === "MEDIUM" || f.severity === "LOW"
    );
    if (criticalFindings.length > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = { scanRepository, fetchMaliciousPackages };
