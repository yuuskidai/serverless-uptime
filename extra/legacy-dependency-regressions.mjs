import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

// Version labels stay honest for these compatible source backports. Exercise
// the installed CJS/ESM implementations before an exact advisory classification.
export async function runLegacyPatchRegressions(root, verification) {
    const profiles = verification.profiles;
    assert.ok(profiles.glob.directories.length > 0);
    assert.ok(profiles.minimatch.directories.length > 0);
    assert.ok(verification.legacy.length > 0);
    const results = [];
    for (const directory of profiles.minimatch.directories) {
        const require = createRequire(resolve(directory, "package.json"));
        const modules = [require(directory), await import(pathToFileURL(resolve(directory, "dist/esm/index.js")))];
        for (const module of modules) {
            const expanded = new module.Minimatch(Array(30).fill("**/../a/b").join("/"), { optimizationLevel: 2, braceExpandMax: 64 });
            assert.ok(expanded.set.length <= 64);
            const matcher = new module.Minimatch("a", { optimizationLevel: 2 });
            const wide = Array.from({ length: 2001 }, (_, i) => [`item${i}`, "file"]);
            matcher.partsMatch = () => { throw new Error("Quadratic deduplication executed"); };
            assert.equal(matcher.secondPhasePreProcess(wide), wide);
            assert.equal(new module.Minimatch("{a/*,a/b}", { optimizationLevel: 2 }).match("a/c"), true);
            assert.equal(module.minimatch("src/a.js", "**/*.js"), true);
            assert.ok(module.makeRe("**/*.js") instanceof RegExp);
            assert.equal(typeof module.AST.fromGlob, "function");
        }
        results.push({ name: "minimatch", directory, completed: true, cases: 6 });
    }
    for (const { directory, version } of verification.legacy) {
        const require = createRequire(resolve(directory, "package.json"));
        const module = require(directory);
        assert.equal(typeof module, "function");
        assert.equal(module("a/file.js", "**/*.js"), true);
        assert.ok(module.makeRe("*.js") instanceof RegExp);
        assert.equal(new module.Minimatch(Array(20).fill("**/../a/b").join("/"), { optimizationLevel: 2 }).set.length, 1);
        results.push({ name: "minimatch-legacy", version, directory, completed: true, cases: 4 });
    }
    const temporary = fs.mkdtempSync(resolve(tmpdir(), "legacy-glob-"));
    try {
        const tree = (path, depth) => {
            fs.mkdirSync(path, { recursive: true });
            fs.writeFileSync(resolve(path, "file.txt"), "fixture");
            if (depth) for (const child of ["a", "b"]) tree(resolve(path, child), depth - 1);
        };
        tree(temporary, 5);
        for (const directory of profiles.glob.directories) {
            const require = createRequire(resolve(directory, "package.json"));
            const modules = [require(directory), await import(pathToFileURL(resolve(directory, "dist/esm/index.js")))];
            for (const glob of modules) {
                const expected = glob.globSync("**/*.txt", { cwd: temporary }).sort();
                assert.equal(expected.length, 63);
                assert.deepEqual((await glob.glob("**/*.txt", { cwd: temporary })).sort(), expected);
                const stream = glob.globStream("**/*.txt", { cwd: temporary });
                await new Promise(resolve => setTimeout(resolve, 30));
                const entries = [];
                for await (const entry of stream) entries.push(entry);
                assert.deepEqual(entries.sort(), expected);
                const controller = new AbortController();
                const reason = new Error("Local cancellation fixture");
                let reads = 0;
                const counted = { ...fs, readdir: (...args) => {
                    if (++reads === 1) controller.abort(reason);
                    return fs.readdir(...args);
                } };
                await assert.rejects(glob.glob("**", { cwd: temporary, signal: controller.signal, fs: counted }), error => error === reason);
                const atReject = reads;
                await new Promise(resolve => setTimeout(resolve, 100));
                assert.equal(reads, atReject);
                assert.equal(reads, 1);
                let syncReads = 0;
                const syncController = new AbortController();
                const syncStream = glob.globStreamSync("**", { cwd: temporary, signal: syncController.signal,
                    fs: { ...fs, readdirSync: (...args) => {
                        if (++syncReads === 1) syncController.abort(reason);
                        return fs.readdirSync(...args);
                    } } });
                await new Promise((resolve, reject) => {
                    syncStream.on("error", error => {
                        try { assert.equal(error, reason); assert.equal(syncReads, 1); resolve(); } catch (failure) { reject(failure); }
                    });
                    syncStream.resume();
                });
            }
            results.push({ name: "glob", directory, completed: true, cases: 10 });
        }
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
    return { completed: true, results };
}
