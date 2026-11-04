const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { createRequire } = require("node:module");

test("legacy source backports and real CJS/ESM consumers reject resource exhaustion", { timeout: 20_000 }, async () => {
    const { verifyLegacyPatches } = await import("../extra/lib/legacy-patch-review.mjs");
    const { loadLegacyInventory } = await import("../extra/security-audit.mjs");
    const { runLegacyPatchRegressions } = await import("../extra/legacy-dependency-regressions.mjs");
    const root = path.resolve(__dirname, "..");
    const result = await runLegacyPatchRegressions(root, verifyLegacyPatches(root, loadLegacyInventory(root)));
    assert.equal(result.completed, true);
    assert.ok(result.results.every((item) => item.completed));
});

test("Axios0 API and undici consumers retain loopback HTTP behavior", { timeout: 10_000 }, async () => {
    const server = createServer((request, response) => {
        if (request.url === "/redirect") {
            response.writeHead(302, { location: "/ok" });
            response.end();
        } else {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ ok: true }));
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
        const axios = require("axios");
        assert.equal(typeof axios.CancelToken.source, "function");
        assert.deepEqual((await axios.get(url + "/redirect", { proxy: false })).data, { ok: true });
        for (const consumer of ["@actions/github", "testcontainers", "cheerio"]) {
            const requireConsumer = createRequire(require.resolve(consumer));
            const undici = requireConsumer("undici");
            assert.deepEqual(await (await undici.fetch(url + "/ok")).json(), { ok: true });
            assert.equal(typeof undici.ProxyAgent, "function");
        }
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

test(
    "Nodemailer CJS MIME supports custom headers and attachments and rejects header injection",
    { timeout: 10_000 },
    async () => {
        const nodemailer = require("nodemailer");
        const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
        const result = await transport.sendMail({
            from: "sender@example.test",
            to: "recipient@example.test",
            subject: "Subject\r\nBcc: attacker@example.test",
            text: "Local body",
            headers: { "X-Local-Fixture": "present" },
            attachments: [{ filename: "fixture.txt", content: "attachment fixture" }],
        });
        const mime = result.message.toString();
        assert.match(mime, /X-Local-Fixture: present/);
        assert.match(mime, /filename=fixture\.txt/);
        assert.doesNotMatch(mime, /\nBcc: attacker/);
        transport.close();
    }
);

test("actual SMTP provider retains TLS, authentication and DKIM options after upgrade", async () => {
    const nodemailer = require("nodemailer");
    const captured = [];
    const replacement = mock.method(nodemailer, "createTransport", (config) => ({
        sendMail: async (mail) => {
            captured.push({ config, mail });
        },
    }));
    try {
        const SMTP = require("../server/notification-providers/smtp");
        const notification = {
            smtpHost: "localhost",
            smtpPort: 465,
            smtpSecure: true,
            smtpIgnoreTLSError: false,
            smtpUsername: "local-fixture-user",
            smtpPassword: "local-fixture-data",
            smtpFrom: "sender@example.test",
            smtpTo: "recipient@example.test",
            smtpCC: "copy@example.test",
            smtpBCC: "blind@example.test",
            smtpDkimDomain: "example.test",
            smtpDkimKeySelector: "fixture",
            smtpDkimPrivateKey: "synthetic-fixture-only",
            customSubject: "{{ msg }}",
            customBody: "{{ msg }}",
        };
        assert.equal(await new SMTP().send(notification, "Local Testing"), "Sent Successfully.");
        const { config, mail } = captured[0];
        assert.equal(config.secure, true);
        assert.equal(config.tls.rejectUnauthorized, true);
        assert.equal(config.auth.user, notification.smtpUsername);
        assert.equal(config.auth.pass, notification.smtpPassword);
        assert.equal(config.dkim.domainName, "example.test");
        assert.equal(config.dkim.keySelector, "fixture");
        assert.equal(mail.cc, notification.smtpCC);
        assert.equal(mail.bcc, notification.smtpBCC);
        assert.equal(mail.subject, "Local Testing");
        assert.equal(mail.text, "Local Testing");
    } finally {
        replacement.mock.restore();
    }
});

test("tar7 retains download-dist extraction API and rejects parent traversal", async () => {
    const tar = require("tar");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-tar-"));
    try {
        const input = path.join(directory, "input");
        const output = path.join(directory, "output");
        fs.mkdirSync(input);
        fs.mkdirSync(output);
        fs.writeFileSync(path.join(input, "fixture.txt"), "safe");
        const archive = path.join(directory, "fixture.tar");
        await tar.c({ file: archive, cwd: input }, ["fixture.txt"]);
        await tar.x({ file: archive, cwd: output });
        assert.equal(fs.readFileSync(path.join(output, "fixture.txt"), "utf8"), "safe");
        const bytes = fs.readFileSync(archive);
        bytes.fill(0, 0, 100);
        bytes.write("../escape.txt", 0);
        bytes.fill(32, 148, 156);
        const checksum = [...bytes.subarray(0, 512)].reduce((a, b) => a + b, 0);
        bytes.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
        fs.writeFileSync(archive, bytes);
        await tar.x({ file: archive, cwd: output });
        assert.equal(fs.existsSync(path.join(directory, "escape.txt")), false);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("protobuf, JSONata, UUID and once retain legacy CommonJS interfaces", async () => {
    const protobuf = require("protobufjs");
    const type = protobuf.parse('syntax="proto3"; message Fixture { string value=1; }').root.lookupType("Fixture");
    const value = { value: "safe" };
    assert.deepEqual(type.toObject(type.decode(type.encode(value).finish())), value);
    assert.equal(await require("jsonata")('$join(["a","b"],",")').evaluate({}), "a,b");
    const uuid = require("uuid");
    assert.equal(uuid.validate(uuid.v1()), true);
    assert.equal(uuid.validate(uuid.v4()), true);
    const module = require("@tootallnate/once");
    const { EventEmitter } = require("node:events");
    const event = new EventEmitter();
    const pending = module.default(event, "fixture");
    event.emit("fixture", 1);
    assert.deepEqual(await pending, [1]);
    assert.equal(typeof require("mssql").ConnectionPool, "function");
    assert.equal(typeof require("@azure/msal-node").ConfidentialClientApplication, "function");
});

test("vendor sources are included in fresh checkout and Docker install input", () => {
    const { spawnSync } = require("node:child_process");
    for (const name of ["glob", "minimatch"]) {
        const manifest = require(`../vendor/${name}/SECURITY_PATCH.json`);
        for (const file of Object.keys(manifest.files).filter((file) => file.startsWith("dist/"))) {
            const result = spawnSync("git", ["check-ignore", "--no-index", "--quiet", `vendor/${name}/${file}`], {
                cwd: path.resolve(__dirname, ".."),
            });
            assert.ifError(result.error);
            assert.equal(result.status, 1);
        }
    }
    const docker = fs.readFileSync(path.join(__dirname, "../docker/dockerfile"), "utf8");
    assert.ok(docker.indexOf("COPY --chown=node:node vendor ./vendor") < docker.indexOf("RUN npm ci"));
});

test("native SQLite still opens a local in-memory database after installer dependency updates", async () => {
    const sqlite = require("@louislam/sqlite3");
    let database;
    await new Promise((resolve, reject) => {
        database = new sqlite.Database(":memory:", (error) => (error ? reject(error) : resolve()));
    });
    try {
        await new Promise((resolve, reject) =>
            database.run("CREATE TABLE fixture(value TEXT)", (error) => (error ? reject(error) : resolve()))
        );
        await new Promise((resolve, reject) =>
            database.run("INSERT INTO fixture(value) VALUES (?)", ["local"], (error) =>
                error ? reject(error) : resolve()
            )
        );
        const row = await new Promise((resolve, reject) =>
            database.get("SELECT value FROM fixture", (error, row) => (error ? reject(error) : resolve(row)))
        );
        assert.equal(row.value, "local");
    } finally {
        await new Promise((resolve, reject) => database.close((error) => (error ? reject(error) : resolve())));
    }
});

test("legacy runtime entry and setup retain the reviewed Node22 source instead of rolling back", () => {
    const semver = require("semver");
    const manifest = require("../package.json");
    assert.equal(semver.satisfies("20.19.0", manifest.engines.node), false);
    assert.equal(semver.satisfies("22.0.0", manifest.engines.node), true);
    const source = fs.readFileSync(path.join(__dirname, "../server/server.js"), "utf8");
    assert.match(source, /const bannedNodeVersions = "<22\.0\.0"/);
    assert.doesNotMatch(manifest.scripts.setup, /git checkout|download-dist/);
    assert.match(manifest.scripts.setup, /npm run build/);
});

test("fork autofix keeps all local checks and fails on format changes without the upstream App", () => {
    const { spawnSync } = require("node:child_process");
    const yaml = require("yaml");
    const source = fs.readFileSync(path.join(__dirname, "../.github/workflows/autofix.yml"), "utf8");
    const workflow = yaml.parse(source);
    const job = workflow.jobs.autofix;
    for (const command of ["npm run lint-fix:js", "npm run lint-fix:style", "npm run fmt", "npm run tsc"]) {
        const step = job.steps.find((step) => step.run === command);
        assert.ok(step, "Existing local check must remain");
        assert.equal(step.if, undefined, "Existing local check must run for the fork");
    }
    const external = job.steps.find((step) => step.uses?.startsWith("autofix-ci/action@"));
    assert.equal(external.uses, "autofix-ci/action@635ffb0c9798bd160680f18fd73371e355b85f27");
    assert.equal(external.if, "github.repository == 'louislam/uptime-kuma'");
    const guard = job.steps.find((step) => step.run === "git diff --exit-code");
    assert.equal(guard.if, "github.repository != 'louislam/uptime-kuma'");
    assert.notEqual(guard["continue-on-error"], true, "Formatter drift must fail the fork job");
    assert.equal(job.permissions.contents, "read");

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fork-format-guard-"));
    try {
        const git = (args) => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
        assert.equal(git(["init", "--quiet"]).status, 0);
        fs.writeFileSync(path.join(directory, "fixture.txt"), "reviewed\n");
        assert.equal(git(["add", "fixture.txt"]).status, 0);
        assert.equal(git(["diff", "--exit-code"]).status, 0);
        fs.writeFileSync(path.join(directory, "fixture.txt"), "formatter changed this\n");
        assert.equal(git(["diff", "--exit-code"]).status, 1);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
