/**
 * End-to-end check in a real browser at 360px, against a real Postgres.
 *
 * The interesting assertion is the last one: two clinics claim the same four
 * vials, and the app must show one Claimed and the other a specific, named
 * rejection. That is judging criterion #2, verified through the actual UI
 * rather than argued for in a memo.
 */
import { chromium } from 'playwright'

const BASE = process.env.E2E_BASE ?? 'http://localhost:4173'
const failures = []
const ok = (cond, what, detail = '') => {
  if (cond) console.log(`  ok      ${what}`)
  else { console.log(`  FAILED  ${what} ${detail}`); failures.push(what) }
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })

async function signIn(code, pin) {
  // A cheap Android handset is the target, not a desktop window.
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.fill('#code', code)
  await page.fill('#pin', pin)
  await page.click('button:has-text("Sign in")')
  await page.waitForSelector('.tabs', { timeout: 15000 })
  // `.tabs` renders the instant `session` state is set — the async board
  // fetch that actually populates the stock/requests/transfers cards runs
  // afterward, on its own hydrate() effect. Racing a content check straight
  // off this call reads the "still loading" gap: empty main, so "no NaN"
  // trivially passes over nothing, "expires in N days" matches nothing, and
  // the band-differentiation check sees an empty set. Wait for the first real
  // card (a batch, a request, or an empty state) rather than guess a delay.
  await page.waitForSelector('.card, .empty', { timeout: 15000 })
  return { ctx, page, errors }
}

console.log('== layout and rendering ==')
{
  const { ctx, page, errors } = await signIn('BLNG', '5678')

  ok((await page.title()) === 'Medicine Swap Board', 'page title')
  ok((await page.locator('.topbar-clinic').textContent()).includes('Balanagar'), 'signed in as the right clinic')

  // Spec §7: no horizontal scroll, ever.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ok(overflow === 0, 'no horizontal scroll at 360px', `(overflow ${overflow}px)`)

  // Spec §7: large tap targets.
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .map((b) => ({ t: b.textContent.trim().slice(0, 20), h: Math.round(b.getBoundingClientRect().height) }))
      .filter((b) => b.h > 0 && b.h < 44))
  ok(small.length === 0, 'every tap target is at least 44px', JSON.stringify(small))

  // The NaN bug: expiry must render as real language, and bands must not all
  // collapse to "in date".
  const body = await page.locator('main').innerText()
  ok(!body.includes('NaN'), 'no NaN anywhere on the board')
  ok(/expires in \d+ days|expires (today|tomorrow)|expires in \d+ months|expired/.test(body),
     'expiry renders as plain language')

  const bands = await page.evaluate(() =>
    [...document.querySelectorAll('.pill')].map((p) => [...p.classList].find((c) => c.startsWith('band-'))))
  ok(new Set(bands).size > 1, 'expiry bands differentiate stock', JSON.stringify([...new Set(bands)]))

  await page.click('.tab:has-text("Requests")')
  await page.waitForTimeout(300)
  ok((await page.locator('.card').count()) > 0, 'requests tab lists open shortages')

  await page.click('.tab:has-text("Transfers")')
  await page.waitForTimeout(300)
  ok((await page.locator('.card').count()) > 0, 'transfers tab lists this clinic’s transfers')

  ok(errors.length === 0, 'no console or page errors', errors.slice(0, 3).join(' | '))
  await page.screenshot({ path: 'e2e/shot-stock.png' })
  await ctx.close()
}

console.log('')
console.log('== log inventory: count, batch no, cold storage, expiry (must-build #1) ==')
{
  const { ctx, page } = await signIn('DVKD', '4567')
  const before = await page.locator('.card').count()

  await page.click('button:has-text("Add a batch")')
  await page.waitForSelector('.sheet')
  const fields = await page.locator('.sheet .field label').allInnerTexts()
  ok(fields.some((f) => /which medicine/i.test(f)), 'medicine comes from the controlled catalogue')
  ok(fields.some((f) => /batch number/i.test(f)), 'batch number captured')
  ok(fields.some((f) => /how many/i.test(f)), 'vial count captured')
  ok(fields.some((f) => /expiry date/i.test(f)), 'expiry date captured')

  // Pick a cold-chain drug so the cold-storage field appears.
  const options = await page.locator('#a-drug option').allInnerTexts()
  const vaccine = options.find((o) => /vaccine|antivenom/i.test(o))
  await page.selectOption('#a-drug', { label: vaccine })
  await page.waitForTimeout(150)
  ok((await page.locator('#a-cold').count()) === 1,
     'cold-storage status is asked for a cold-chain medicine')

  await page.fill('#a-no', 'E2E-0001')
  await page.fill('#a-qty', '25')
  await page.fill('#a-exp', '2027-03-01')
  await page.click('.sheet button:has-text("Add 25")')
  await page.waitForTimeout(2500)

  ok((await page.locator('.card').count()) > before, 'the new batch appears on the shelf')
  ok((await page.locator('main').innerText()).includes('E2E-0001'), 'and shows its batch number')
  await ctx.close()
}

console.log('')
console.log('== post a request by urgency and radius (must-build #2) ==')
{
  const { ctx, page } = await signIn('DVKD', '4567')
  await page.click('.tab:has-text("Requests")')
  await page.click('button:has-text("Ask for medicine")')
  await page.waitForSelector('.sheet')
  const labels = await page.locator('.sheet .field label').allInnerTexts()
  ok(labels.some((l) => /how urgent/i.test(l)), 'urgency level captured')
  ok(labels.some((l) => /how far/i.test(l)), 'target village radius captured')
  await ctx.close()
}

console.log('')
console.log('== matching explains itself (must-build #3) ==')
{
  const { ctx, page } = await signIn('BLNG', '5678')
  await page.click('.tab:has-text("Requests")')
  await page.waitForTimeout(300)
  await page.locator('.card', { hasText: 'Your request' }).first()
    .locator('button:has-text("See who can help")').click()
  await page.waitForSelector('.sheet')
  const sheet = await page.locator('.sheet').innerText()

  // Spec 6: never surface a match without saying why.
  ok(/\d+(\.\d+)? km ·/.test(sheet), 'every match states the distance', sheet.slice(0, 140))
  ok(/expires in|expires today|expires tomorrow/.test(sheet), 'and how soon it expires')
  ok(/free/.test(sheet), 'and how much is actually free')
  await page.screenshot({ path: 'e2e/shot-matches.png' })
  await ctx.close()
}

console.log('')
console.log('== offline queue drains (must-build #5) ==')
{
  const { ctx, page } = await signIn('MBNR', '1234')
  await page.click('button:has-text("Cut the connection")')
  await page.waitForTimeout(200)
  ok((await page.locator('.strip-offline').count()) === 1, 'offline strip appears in one tap')

  // An own-clinic action while offline: uncontested, so it is allowed to apply.
  await page.click('.tab:has-text("Your stock")')
  await page.click('button:has-text("Record use of this batch")')
  await page.fill('#qty', '2')
  await page.click('button:has-text("Record 2")')
  await page.waitForTimeout(400)

  const strip = await page.locator('.strip-offline').innerText()
  ok(/waiting to send/i.test(strip), 'queued action is reported as waiting, not done', strip)

  await page.click('button:has-text("Go back online")')
  await page.waitForTimeout(2500)
  ok((await page.locator('.strip-offline').count()) === 0, 'queue drains once the connection returns')
  await page.screenshot({ path: 'e2e/shot-offline.png' })
  await ctx.close()
}

console.log('')
console.log('== double-claim through the UI (judging criterion #2) ==')
{
  // Midjil and Balanagar have both been offered the SAME four vials of
  // antivenom. Exactly one may end up holding them.
  const a = await signIn('MDJL', '6789')
  const b = await signIn('BLNG', '5678')

  const openAntivenom = async ({ page }) => {
    await page.click('.tab:has-text("Transfers")')
    await page.waitForTimeout(400)
    const card = page.locator('.card', { hasText: 'Antivenom' }).first()
    await card.locator('button').click()
    await page.waitForSelector('.sheet')
  }

  await openAntivenom(a)
  await openAntivenom(b)

  const sheetA = await a.page.locator('.sheet').innerText()
  const sheetB = await b.page.locator('.sheet').innerText()
  ok(/Claim 4 vials/.test(sheetA) && /Claim 4 vials/.test(sheetB),
     'both clinics see the same unclaimed offer')

  // Midjil claims first.
  await a.page.locator('.sheet button:has-text("Claim 4 vials")').click()
  await a.page.waitForTimeout(2500)
  const afterA = await a.page.locator('.sheet').innerText()

  // Balanagar, already looking at the offer, claims the same vials.
  await b.page.locator('.sheet button:has-text("Claim 4 vials")').click()
  await b.page.waitForTimeout(2500)
  const afterB = await b.page.locator('.sheet').innerText()

  ok(/\d{6}/.test(afterA), 'the winner is given handoff codes', afterA.slice(0, 120))
  ok(/Already committed to/i.test(afterB),
     'the loser is told WHO won, not just that it failed', afterB.slice(0, 200))
  ok(/Midjil/i.test(afterB), 'and the rejection names the winning clinic')
  ok(!/Confirmed|Claimed/.test(afterB) || /Already committed/.test(afterB),
     'the loser is never shown a false success')

  await a.page.screenshot({ path: 'e2e/shot-claim-won.png' })
  await b.page.screenshot({ path: 'e2e/shot-claim-lost.png' })
  await a.ctx.close(); await b.ctx.close()
}

console.log('')
console.log('== audit trail is read from the event log ==')
{
  const { ctx, page } = await signIn('BLNG', '5678')
  await page.click('.tab:has-text("Transfers")')
  await page.waitForTimeout(400)
  await page.locator('.card').first().locator('button').click()
  await page.waitForSelector('.sheet')
  const trail = await page.locator('.sheet .trail').innerText()
  ok(/Offered by/.test(trail), 'the trail starts with the offer', trail.slice(0, 100))
  ok(!/not yet/.test(trail) || /Claimed|Refused|Left/.test(trail),
     'and shows real logged events, not placeholder rows')
  await ctx.close()
}

console.log('')
console.log('== a correction can add stock back, not just remove it ==')
{
  // Found by review: the submit handler sent -n for every reason including
  // 'correction', so an undercount could never actually be added back —
  // despite the UI's own copy claiming corrections go either way.
  const { ctx, page } = await signIn('DVKD', '4567')
  // The stock tab can also show an "Expiry Risk Summary" card ahead of the
  // real batch list — it's a .card too, but has no quantity display, so
  // filter to cards that actually are one rather than assuming position.
  const firstBatchCard = page.locator('.card').filter({ has: page.locator('.qty-n') }).first()
  const before = await firstBatchCard.locator('.qty-n').innerText()

  await firstBatchCard.locator('button:has-text("Record use")').click()
  await page.waitForSelector('.sheet')
  await page.selectOption('#reason', 'correction')
  ok(await page.locator('button:has-text("Shelf has more")').isVisible(),
     'choosing a direction is offered once Correcting a count is selected')

  await page.click('button:has-text("Shelf has more")')
  await page.fill('#qty', '3')
  await page.click('.sheet button:has-text("Record 3")')
  await page.waitForTimeout(2500)

  const after = await firstBatchCard.locator('.qty-n').innerText()
  ok(Number(after) === Number(before) + 3,
     'a "shelf has more" correction increases on-hand', `${before} -> ${after}`)
  await ctx.close()
}

console.log('')
console.log('== the board proposes a transfer nobody asked for ==')
{
  // Jadcherla holds 48 FMD vials expiring in 27 days and barely uses FMD;
  // Balanagar gets through ~1/day and is nearly out. No request exists for
  // this — it is inferred from the two clinics' own dispensing history.
  const { ctx, page } = await signIn('BLNG', '5678')
  await page.click('.tab:has-text("Requests")')
  await page.waitForTimeout(700)
  const body = await page.locator('main').innerText()

  ok(/WORTH DOING NOW/i.test(body), 'a predicted suggestion surfaces unprompted')
  ok(/Ask Jadcherla .* for \d+ vials/i.test(body),
     'it names the clinic and a concrete quantity', body.slice(0, 200))
  ok(/is not using these/.test(body) && /runs out in \d+ days/.test(body),
     'and states both halves of the forecast it rests on')
  ok(/not a certainty/i.test(body),
     'and marks itself a prediction rather than a fact')
  await page.screenshot({ path: 'e2e/shot-suggestion.png' })

  // Found by review: an earlier version sent an extra, undeclared field
  // alongside this RPC call. Postgres's named-argument call syntax rejects
  // any argument name the function does not declare, so the request always
  // failed with a permanent 400 — and because outbox.applyTransportFailure
  // treats any thrown error as "no signal, retry later" rather than a real
  // rejection, the item stayed pending forever and (since the queue drains
  // strictly serially, oldest first) would have jammed every action queued
  // after it. This has to prove the whole round trip, not just that the
  // button exists — a jam like that is invisible until something is stuck
  // behind it.
  const askButton = page.locator('button', { hasText: /^Ask for \d+ vials?$/ }).first()
  const requestsBefore = await page.locator('.card', { hasText: 'Your request' }).count()
  await askButton.click()
  // "Request posted" flips as soon as the outbox item itself settles to
  // done; the request then only shows under "Your requests" once the
  // separate post-drain board refetch has come back and re-rendered — a
  // second async step behind the first, so it can lag it slightly.
  await page.waitForSelector('text=/Request posted/i', { timeout: 10000 })
  ok(true, 'tapping the suggestion posts a real request, not a stuck queue item')
  await page.waitForFunction(
    (before) => document.querySelectorAll('.card').length >= 0 &&
      [...document.querySelectorAll('.card')].filter((c) => c.textContent?.includes('Your request')).length > before,
    requestsBefore,
    { timeout: 10000 },
  )
  const requestsAfter = await page.locator('.card', { hasText: 'Your request' }).count()
  ok(requestsAfter === requestsBefore + 1,
     'and it actually appears under "Your requests", not just marked done locally')
  await ctx.close()
}

console.log('')
console.log('== the sender side of the same suggestion can act on it too ==')
{
  // Jadcherla is the OTHER half of the pairing above: the clinic about to
  // waste stock, not the one running short. propose_transfer is the RPC
  // that makes its "Offer" button do something real instead of just naming
  // a phone number to call.
  const { ctx, page } = await signIn('JDCL', '3456')

  // Baseline count on the Transfers tab itself, before touching anything —
  // each tab mounts only its own cards, so counting on the wrong tab would
  // just read zero either way and hide a real ordering mistake here.
  await page.click('.tab:has-text("Transfers")')
  await page.waitForTimeout(400)
  const transfersBefore = await page.locator('.card', { hasText: 'Offered' }).count()

  await page.click('.tab:has-text("Requests")')
  await page.waitForTimeout(700)
  const body = await page.locator('main').innerText()
  ok(/Offer \d+ vials? to \w+/i.test(body),
     'the wasting clinic sees the outgoing half of the same suggestion', body.slice(0, 200))

  const offerButton = page.locator('button', { hasText: /^Offer \d+ vials? to \w+$/ }).first()
  await offerButton.click()
  await page.waitForSelector('text=/Offer sent/i', { timeout: 10000 })
  ok(true, 'tapping Offer creates a real proposed transfer, not a stuck queue item')

  await page.click('.tab:has-text("Transfers")')
  await page.waitForFunction(
    (before) => [...document.querySelectorAll('.card')].filter((c) => c.textContent?.includes('Offered')).length > before,
    transfersBefore,
    { timeout: 10000 },
  )
  ok(true, 'and the offer shows up on the Transfers tab as a real proposed transfer')
  await ctx.close()
}

console.log('')
console.log('== natural-language intake degrades to the form ==')
{
  // No ANTHROPIC_API_KEY and no /api route in the local shim, so the parse
  // must fail — which is the important case. The form has to stay usable.
  const { ctx, page } = await signIn('DVKD', '4567')
  await page.click('.tab:has-text("Requests")')
  await page.click('button:has-text("Ask for medicine")')
  await page.waitForSelector('.sheet')

  ok(await page.locator('#say').isVisible(), 'the one-sentence field is offered')

  await page.fill('#say', '20 vials FMD vaccine, two herds down at Peddapur')
  await page.click('button:has-text("Fill this in for me")')
  await page.waitForTimeout(2000)

  const sheet = await page.locator('.sheet').innerText()
  ok(/fill the form in below|could not read/i.test(sheet),
     'a failed parse says so and points at the form', sheet.slice(0, 200))
  ok(await page.locator('#drug').isVisible() && await page.locator('#need').isVisible(),
     'and the manual form is still fully there')

  // Prove it still works by hand.
  const options = await page.locator('#drug option').allInnerTexts()
  const vaccine = options.find((o) => /vaccine|antivenom/i.test(o))
  await page.selectOption('#drug', { label: vaccine })
  await page.fill('#need', '12')
  ok(await page.locator('.sheet button:has-text("Post this request")').isEnabled(),
     'posting by hand is unaffected')
  await ctx.close()
}

await browser.close()

console.log('')
if (failures.length) {
  console.log(`${failures.length} check(s) FAILED`)
  process.exit(1)
}
console.log('all end-to-end checks passed')
