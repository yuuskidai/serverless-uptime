const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { createRequire } = require("node:module");
const { runInNewContext } = require("node:vm");

/**
 * Load the actual component options with only UI/IO boundaries replaced.
 * @param {object} options Synthetic readiness/authentication state
 * @param {boolean} options.publicReady Whether the public snapshot is already loaded
 * @param {boolean} options.loggedIn Whether the synthetic root is authenticated
 * @returns {object} Actual component methods with isolated IO controls
 */
function statusPageFixture({ publicReady = true, loggedIn = true } = {}) {
    const { parse } = require("@vue/compiler-sfc");
    const espree = require("espree");
    const source = fs.readFileSync(
        process.env.STATUS_PAGE_COMPONENT_BASELINE_FILE || path.join(__dirname, "../src/pages/StatusPage.vue"),
        "utf8"
    );
    const descriptor = parse(source).descriptor;
    const script = descriptor.script.content;
    const ast = espree.parse(script, { ecmaVersion: "latest", sourceType: "module", range: true });
    const exported = ast.body.find((node) => node.type === "ExportDefaultDeclaration").declaration;
    const timers = [];
    const globals = {
        dayjs: require("dayjs"),
        setInterval: () => 1,
        clearInterval() {},
        setTimeout: (callback) => timers.push(callback),
        window: { addEventListener() {} },
        document: {},
        location: {},
        favicon: { badge() {} },
        toast: { error() {}, success() {} },
    };
    for (const node of ast.body.filter((node) => node.type === "ImportDeclaration")) {
        for (const specifier of node.specifiers) {
            if (!(specifier.local.name in globals)) {
                globals[specifier.local.name] = {};
            }
        }
    }
    const component = runInNewContext("(" + script.slice(...exported.range) + ")", globals);
    const pending = [];
    const saved = [];
    const errors = [];
    const socket = {
        connected: true,
        emit(event, ...args) {
            if (event === "getStatusPage") {
                pending.push({ slug: args[0], ack: args[1] });
            }
            if (event === "saveStatusPage") {
                saved.push({ config: JSON.parse(JSON.stringify(args[1])), ack: args.at(-1) });
            }
        },
    };
    const vm = {
        $route: { params: { slug: "synthetic-status" }, query: {} },
        $root: {
            loggedIn,
            username: "synthetic-user",
            socket: { connected: true, connectCount: 1 },
            publicGroupList: [{ name: "Existing group", monitorList: [] }],
            getSocket: () => socket,
            initSocketIO() {},
            toastError: (message) => errors.push(message),
        },
    };
    Object.assign(vm, component.data.call(vm));
    for (const [name, method] of Object.entries(component.methods)) {
        vm[name] = method.bind(vm);
    }
    for (const [name, getter] of Object.entries(component.computed)) {
        Object.defineProperty(vm, name, { get: () => getter.call(vm) });
    }
    const config = (values = {}) => ({
        slug: "synthetic-status",
        rssTitle: "",
        analyticsScriptUrl: "",
        autoRefreshInterval: 30,
        domainNameList: ["synthetic.invalid"],
        ...values,
    });
    vm.hasToken = true;
    vm.slug = "synthetic-status";
    vm.config = config();
    vm.loading = false;
    vm.publicDataSlug = publicReady ? vm.slug : null;
    vm.updateHeartbeatList = () => {};
    vm.loadIncidentHistory = () => {};
    vm.updateUpdateTimer = () => {};
    const sessionChanged = () =>
        component.watch.privateConfigSession
            ? component.watch.privateConfigSession.call(vm)
            : component.watch["$root.loggedIn"].call(vm, vm.$root.loggedIn);
    return {
        vm,
        component,
        config,
        pending,
        saved,
        errors,
        timers,
        sessionChanged,
        location: globals.location,
        template: descriptor.template.content,
    };
}

test("StatusPage private ACK readiness prevents the reproduced RSS and analytics lost edit", () => {
    const f = statusPageFixture({ loggedIn: false });
    f.vm.edit();
    assert.equal(Boolean(f.vm.editMode), false, "Editor must stay closed before private configuration arrives");
    f.vm.save();
    assert.equal(f.saved.length, 0, "Direct Save must fail closed before readiness");
    f.vm.$root.loggedIn = true;
    f.sessionChanged();
    assert.equal(f.pending.length, 1);
    assert.equal(Boolean(f.vm.editMode), false);
    f.pending[0].ack({ ok: true, config: f.config() });
    assert.equal(f.vm.editMode, true);
    assert.match(f.template, /v-if="editMode" class="sidebar"/);
    assert.doesNotMatch(f.template, /enableEditMode/);
    f.vm.config.rssTitle = "Synthetic custom RSS";
    f.vm.config.analyticsScriptUrl = "https://synthetic.invalid/analytics.js";
    // Even a duplicate ACK cannot replace an already opened draft.
    f.pending[0].ack({ ok: true, config: f.config() });
    f.vm.save();
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].config.rssTitle, "Synthetic custom RSS");
    assert.equal(f.saved[0].config.analyticsScriptUrl, "https://synthetic.invalid/analytics.js");
    assert.deepEqual(f.saved[0].config.domainNameList, ["synthetic.invalid"]);
});

test("StatusPage already authenticated Edit fetches private config without a new login transition", () => {
    const f = statusPageFixture();
    f.vm.edit();
    assert.equal(f.pending.length, 1);
    assert.equal(Boolean(f.vm.editMode), false);
    f.pending[0].ack({ ok: true, config: f.config({ domainNameList: ["private.invalid"] }) });
    assert.equal(f.vm.editMode, true);
    assert.deepEqual(Array.from(f.vm.config.domainNameList), ["private.invalid"]);
    assert.equal(typeof f.vm.config.customCSS, "string");
});

test("StatusPage public groups and icon finish loading before private ACK can expose an editor", async () => {
    const f = statusPageFixture({ publicReady: false });
    f.vm.loading = true;
    let resolvePublic;
    f.vm.getData = () =>
        new Promise((resolve) => {
            resolvePublic = resolve;
        });
    await f.component.mounted.call(f.vm);
    f.vm.edit();
    assert.equal(f.pending.length, 0);
    assert.equal(Boolean(f.vm.editMode), false);
    const groups = [{ name: "Loaded group", monitorList: [{ id: 1 }] }];
    const incident = { id: 1 };
    resolvePublic({
        data: {
            config: f.config({ icon: "/synthetic-icon.svg" }),
            publicGroupList: groups,
            maintenanceList: [],
            incident,
        },
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.pending.length, 1);
    assert.equal(f.vm.$root.publicGroupList, groups);
    assert.equal(f.vm.incident, incident);
    assert.equal(f.vm.imgDataUrl, "/synthetic-icon.svg");
    f.pending[0].ack({ ok: true, config: f.config() });
    f.vm.config.rssTitle = "Retained private draft";
    await Promise.resolve();
    assert.equal(f.vm.config.rssTitle, "Retained private draft");
    assert.equal(f.vm.$root.publicGroupList, groups);
});

test("StatusPage ignores old request ACKs and permits explicit retry after a private load failure", () => {
    const f = statusPageFixture();
    f.vm.edit();
    f.vm.edit();
    assert.equal(f.pending.length, 2);
    f.pending[0].ack({ ok: true, config: f.config({ rssTitle: "stale" }) });
    assert.equal(Boolean(f.vm.editMode), false);
    assert.equal(f.vm.config.rssTitle, "");
    f.pending[1].ack({ ok: false, msg: "Synthetic unavailable" });
    assert.equal(f.vm.enableEditMode, false);
    assert.equal(Boolean(f.vm.editMode), false);
    f.vm.save();
    assert.equal(f.saved.length, 0);
    f.vm.edit();
    assert.equal(f.pending.length, 3);
    f.pending[2].ack({ ok: true, config: f.config({ rssTitle: "current" }) });
    assert.equal(f.vm.editMode, true);
    assert.equal(f.vm.config.rssTitle, "current");
});

test("StatusPage reconnect invalidates private readiness while preserving a same-user draft", () => {
    const f = statusPageFixture();
    f.vm.edit();
    f.pending[0].ack({ ok: true, config: f.config() });
    f.vm.config.rssTitle = "Unsaved draft";
    f.vm.$root.socket.connected = false;
    assert.equal(Boolean(f.vm.editMode), false);
    f.sessionChanged();
    f.vm.save();
    assert.equal(f.saved.length, 0);
    f.vm.$root.socket.connected = true;
    f.vm.$root.socket.connectCount++;
    f.sessionChanged();
    f.pending[1].ack({ ok: false, msg: "Synthetic authentication pending" });
    assert.equal(f.vm.enableEditMode, false);
    f.vm.edit();
    f.pending[2].ack({ ok: true, config: f.config({ rssTitle: "server snapshot" }) });
    assert.equal(f.vm.editMode, true);
    assert.equal(f.vm.config.rssTitle, "Unsaved draft");
    f.vm.save();
    assert.equal(f.saved[0].config.rssTitle, "Unsaved draft");
});

test("StatusPage logout, new slug and unmount reject old private replies and stale save callbacks", () => {
    for (const change of ["logout", "slug", "unmount"]) {
        const f = statusPageFixture();
        f.vm.edit();
        if (change === "logout") {
            f.vm.$root.loggedIn = false;
            f.sessionChanged();
        }
        if (change === "slug") {
            f.vm.slug = "different-status";
            f.sessionChanged();
        }
        if (change === "unmount") {
            f.component.beforeUnmount.call(f.vm);
        }
        f.pending[0].ack({ ok: true, config: f.config() });
        assert.equal(Boolean(f.vm.editMode), false);
        f.vm.save();
        assert.equal(f.saved.length, 0);
    }
    const f = statusPageFixture();
    f.vm.edit();
    f.pending[0].ack({ ok: true, config: f.config() });
    f.vm.save();
    f.vm.$root.loggedIn = false;
    f.sessionChanged();
    f.saved[0].ack({ ok: true, publicGroupList: [] });
    assert.equal(f.timers.length, 0);
});

test("StatusPage Edit cannot cancel a pending Save redirect after a slug rename", () => {
    const f = statusPageFixture();
    f.vm.edit();
    f.pending[0].ack({ ok: true, config: f.config() });
    f.vm.config.slug = "renamed-synthetic";
    f.vm.save();
    const requestId = f.vm.privateConfigRequestId;
    f.vm.edit();
    assert.equal(f.pending.length, 1);
    assert.equal(f.vm.privateConfigRequestId, requestId);
    f.saved[0].ack({ ok: true, publicGroupList: [] });
    assert.equal(f.vm.enableEditMode, false);
    f.vm.edit();
    assert.equal(f.pending.length, 1);
    assert.equal(f.vm.privateConfigRequestId, requestId);
    assert.equal(f.timers.length, 1);
    f.timers[0]();
    assert.equal(f.location.href, "/status/renamed-synthetic");
});

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
