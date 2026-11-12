// UI integration test. A separate browser storage profile; POST /api/dj and
// lesson sync are stubbed so the test never writes the owner's cloud ledger.
// Set TEST_BASE_URL, DJ_PASSCODE and (if needed) PLAYWRIGHT_MODULE externally.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3198";
const manifest = JSON.parse(readFileSync(new URL("../src/data/crate-manifest.json", import.meta.url)));
const fixture = readFileSync(new URL("../public/fixtures/test-120bpm.mp3", import.meta.url));
const ginza = manifest.find(t => /j balvin - ginza\.mp3/i.test(t.name));
assert.ok(ginza);
// The transport is stubbed with a real tiny MP3, so its expected byte size must
// match that fixture. All production IDs and the 599-track order remain real.
ginza.size = fixture.length;
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, colorScheme: "dark" });
    if (process.env.DJ_PASSCODE) await context.addCookies([{ name: "dj_pass", value: process.env.DJ_PASSCODE, url: base }]);
    await context.addInitScript(entries => {
      if (!localStorage.getItem("djsm.crate-metadata")) localStorage.setItem("djsm.crate-metadata", JSON.stringify(entries));
    }, manifest);
    await context.route("**/api/lessons", route => route.fulfill({ json: { events: [] } }));
    const shared = new Map();
    let failSave = false;
    const sync = async route => {
      if (route.request().method() === "POST") {
        if (failSave) return route.fulfill({ status: 503, json: { error: "offline" } });
        const body = route.request().postDataJSON();
        const override = { ...body, updatedAt: new Date().toISOString() };
        shared.set(body.id, override);
        return route.fulfill({ json: { override } });
      }
      return route.fulfill({ json: { overrides: Array.from(shared.values()) } });
    };
    await context.route("**/api/crate-metadata", sync);
    const sent = [];
    await context.route("**/api/dj", async route => {
      if (route.request().method() !== "POST") return route.fulfill({ json: { models: ["claude","fable","gemini","grok","openai","muse"].map(id => ({id,label:id,model:id,available:true})) } });
      const body = route.request().postDataJSON(); sent.push(body);
      await route.fulfill({ json: { command: { action: "none", say: "UI test" }, provider: body.brainModel,
        model: body.brainModel, cost_usd: 0.001, latency_ms: 100 } });
    });
    const downloads = [];
    await context.route("**/api/crate/*", async route => {
      downloads.push(new URL(route.request().url()).pathname.split("/").at(-1));
      await route.fulfill({ status: 200, contentType: "audio/mpeg", body: fixture });
    });
    const page = await context.newPage();
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(base);
    const crate = page.locator("section").filter({ has: page.getByText("Crate", { exact: true }) });
    await page.waitForFunction(() => document.querySelector('[aria-label="Cerebro model"] option[value="gemini"]')?.disabled === false);
    assert.equal(await page.getByLabel("Cerebro model", { exact: true }).inputValue(), "claude");
    await crate.getByRole("status").filter({ hasText: "599 of 599" }).waitFor();
    const search = page.getByRole("searchbox");
    await search.fill("j balvin ginza");
    assert.ok(await crate.getByRole("button", { name: /J Balvin - Ginza/ }).count() > 0);
    await page.getByLabel(`Genre for J Balvin - Ginza`, { exact: true }).fill("Test genre");
    await page.getByLabel(`Genre for J Balvin - Ginza`, { exact: true }).press("Enter");
    await page.getByText("Saved across devices:", { exact: false }).waitFor();
    await search.fill("ginza test genre");
    assert.equal(await crate.locator("ul").first().locator("li").count(), 1);
    await page.getByLabel("Sort crate", { exact: true }).selectOption("artist");
    const requestedTrack = page.waitForResponse(r => r.url().includes(`/api/crate/${ginza.id}`));
    await crate.getByTitle(ginza.name, { exact: true }).click();
    await requestedTrack;
    assert.ok(downloads.includes(ginza.id), "filtered/sorted tap downloads the correct stable track ID");
    await search.fill("no such music 123456789");
    await crate.getByText("No matching tracks.", { exact: false }).waitFor();
    await crate.getByRole("button", { name: "Clear filters" }).click();
    for (const sort of ["title", "artist", "genre", "bpm", "original"]) await page.getByLabel("Sort crate", { exact: true }).selectOption(sort);
    await page.getByLabel("Filter crate by genre", { exact: true }).selectOption("Test genre");
    assert.equal(await crate.locator("ul").first().locator("li").count(), 1);
    // Every visible provider changes the actual next POST, not just the label.
    for (const model of ["gemini", "grok", "openai", "muse", "claude", "fable"]) {
      await page.getByLabel("Cerebro model", { exact: true }).selectOption(model);
      await page.getByLabel("Vibe note to the brain").fill("UI selection test; do nothing");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByLabel("Cerebro model", { exact: true }).waitFor({ state: "visible" });
      await page.waitForFunction(() => !document.querySelector('[aria-label="Cerebro model"]').disabled);
      assert.equal(sent.at(-1).brainModel, model);
      assert.equal(sent.at(-1).crate[0].t.includes("A Tu Merced"), true, "UI sort/filter must not reorder or narrow the model's crate");
    }
    await page.getByLabel("Cerebro model", { exact: true }).selectOption("openai");
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[aria-label="Cerebro model"]')?.value === "openai");
    await search.fill("ginza test genre");
    await page.getByLabel(`Genre for J Balvin - Ginza`, { exact: true }).waitFor();
    assert.equal(await page.getByLabel(`Genre for J Balvin - Ginza`, { exact: true }).inputValue(), "Test genre");
    await search.fill("");
    await page.getByLabel("Filter crate by genre", { exact: true }).selectOption("Test genre");
    await page.getByLabel(`Genre for J Balvin - Ginza`, { exact: true }).fill("Bachata");
    await page.getByLabel(`Genre for J Balvin - Ginza`, { exact: true }).press("Enter");
    await crate.getByText("No matching tracks.", { exact: false }).waitFor();
    assert.equal(await page.getByLabel("Filter crate by genre", { exact: true }).inputValue(), "Test genre", "editing the last member must not mislabel the active filter as All genres");
    await crate.getByRole("button", { name: "Clear filters" }).click();
    await search.fill("ginza bachata");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal overflow");
    assert.ok(sent.every(body => body.crate.find(t => t.t === "J Balvin - Ginza")?.genre === "Test genre"));
    // A truly separate device starts with stale original metadata, not the
    // first browser's localStorage. It must receive the saved cloud correction.
    const second = await browser.newContext();
    await second.addCookies(await context.cookies());
    await second.addInitScript(entries => localStorage.setItem("djsm.crate-metadata", JSON.stringify(entries)), manifest);
    await second.route("**/api/lessons", r => r.fulfill({json:{events:[]}}));
    await second.route("**/api/crate-metadata", sync);
    await second.route("**/api/dj", r => r.fulfill({json:{models:[]}}));
    const other = await second.newPage(); await other.goto(base);
    await other.getByRole("searchbox").fill("ginza bachata");
    await other.getByLabel("Genre for J Balvin - Ginza", {exact:true}).waitFor();
    assert.equal(await other.getByLabel("Genre for J Balvin - Ginza", {exact:true}).inputValue(), "Bachata");
    await second.close();
    failSave = true;
    await page.getByLabel("Genre for J Balvin - Ginza", {exact:true}).fill("Not saved");
    await page.getByLabel("Genre for J Balvin - Ginza", {exact:true}).press("Enter");
    await page.getByText("Genre NOT saved to cloud.", {exact:false}).waitFor();
    assert.equal(shared.get(ginza.id).genre, "Bachata");
    await page.getByLabel("Vibe note to the brain").fill("30 seconds per track, salsa and bachata with stems and loops");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Cerebro model"]').disabled);
    assert.ok(sent.at(-1).crate.length > 20);
    assert.ok(sent.at(-1).crate.every(t => /salsa|bachata/i.test(t.genre)), "genre-scoped candidate window");
    assert.ok(sent.at(-1).crate.every(t => t.s && t.stemRoles.length), "stem roles and song genres ride the SAME candidate");
    assert.deepEqual(errors, []);
    console.log(`PASS: ${viewport.width}px search/filter/sort, correct track tap, five model POSTs, reload persistence, no page errors/overflow`);
    if (process.env.TEST_SCREENSHOT) await page.screenshot({ path: `${process.env.TEST_SCREENSHOT}-${viewport.width}.png`, fullPage: true });
    await context.close();
  }
} finally { await browser.close(); }
