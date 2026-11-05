---
title: Plans, usage and billing
navLabel: Plans and billing
description: How box-hours, plans, credits and annual billing work, what happens when you run out, and how to upgrade, change or cancel.
---

You pay Talyn for the machines your agents run on. The model runs on the Claude or ChatGPT subscription you connect, so there is no token bill from Talyn.

## Box-hours

Every agent run happens in a sandbox, which Talyn calls a box. Usage is counted in box-hours. One box-hour is one Standard box running for one hour.

- Talyn counts each second a box is awake and running.
- A sleeping box uses nothing. A box goes to sleep after 10 idle minutes.
- Bigger boxes use more of your allowance, smaller boxes use less.

| Size | Box-hours per hour | Price per hour on credits |
| --- | --- | --- |
| Small | 0.5 | $0.11 |
| Standard | 1 | $0.22 |
| Medium | 1.25 | $0.275 |
| Large | 2 | $0.44 |
| X-Large | 2.5 | $0.55 |

For example, a ten-minute run on a Standard box uses a sixth of a box-hour.

Sessions, threads, fix runs, code reviews, skills, workflow actions and loops all run on boxes. Local sessions in the desktop app run on your computer and use no box-hours.

## Plans

| | Free | Pro |
| --- | --- | --- |
| Price | $0 | $40 a month, or $400 a year |
| Box-hours each month | 10 | 200 |
| Boxes running at once | 2 | 100 |
| Box sizes | Small and Standard | All sizes |
| Credits and auto top-up | No | Yes |
| Keep every new PR green automatically | No | Yes |
| Review every new PR automatically | No | Yes |

Everything else is on both plans: sessions, threads, the PR dashboard, fixing pull requests, keeping a pull request green when you turn it on for that pull request, the merge queue, code review, skills, workflows, loops, Slack and MCP servers.

Box-hours and running boxes are counted for your account, across every workspace you own.

Some screens in the app still call the paid plan "Unlimited". It is the same plan as Pro.

## Your usage

The gauge at the bottom of the sidebar shows your plan, the share of box-hours you have left this month, when they reset, and your credit balance. Select it to open the full page.

To see the details, open **Settings > Plan and usage** in the desktop app, or **Settings > Billing** in the web app. The page shows:

- How many box-hours you have used this period, and how many boxes are running now.
- Your credit balance and auto top-up.
- The box sizes your plan can use.
- Your order history and invoices.

Talyn warns you when you have used 50%, 80% and 100% of your box-hours.

### The monthly period

On the free plan, box-hours reset at the start of each calendar month, in UTC. On Pro, they reset each month on the day your subscription renews. An annual Pro plan also resets monthly. Box-hours you do not use do not roll over.

## When you run out

When your box-hours are used up:

- Work that is already running finishes.
- New boxes do not start, and the page says **Out of hours: new boxes are paused. Running turns finish.**
- Work that Talyn starts for you, such as loops, workflow actions, merge queue fixes and automatic reviews, waits with a notice in the app. It starts when your hours reset or when you add credits.

On Free, you can wait for the next month or upgrade to Pro. On Pro, add credits or turn on auto top-up to keep going.

Two other limits can stop a new box:

- **All your boxes are busy**: you have as many boxes running as your plan allows. A new box starts when one stops.
- **This size needs Pro**: the free plan can start only Small and Standard boxes.

## Credits

Credits are a balance in US dollars, for use above your monthly box-hours. They are on Pro. Your included box-hours are used first, then credits, at the hourly price of the box size.

| Pack | Credit you get |
| --- | --- |
| $25 | $25 |
| $100 | $105 (5% extra) |
| $500 | $550 (10% extra) |

Credits last 12 months from the day you buy them. The page warns you when some will expire in the next 30 days.

To buy credits:

1. Open the plan page.
2. Under **Credits**, select **Add credits**.
3. Pick a pack and pay.

### Auto top-up

Turn on **Buy credits automatically when the balance is low** to buy a pack when your balance drops. Set:

- **When the balance is below ($)**: the default is $5.
- **Buy**: the pack. The default is $25.
- **At most per month ($)**: a cap on auto top-ups. The default is $100.

If an automatic charge fails, the page says so and offers **Buy credits**.

## Upgrade to Pro

1. Open the plan page.
2. Select **Upgrade**.
3. Choose **Monthly** ($40 a month) or **Annual** ($400 a year).
4. Pay on the checkout page.

The annual plan costs the same as 10 months, so you get 2 months free. If you pay monthly, you can switch to annual from the plan page. You pay the prorated difference at once.

## Manage or cancel

Select **Manage billing** on the plan page. It opens the billing portal, where you can:

- Change your payment method.
- Download invoices.
- Switch from annual to monthly.
- Cancel.

When you cancel, you keep Pro until the end of the period you paid for. Then your account moves to the free plan, which keeps working.

If a payment fails, you keep your plan while the payment is retried. Update your payment method in the portal. If the retries run out, the plan drops to Free.

Payments are handled by Polar, the merchant of record. Talyn never sees your card.

## The older plan

If you subscribed to Talyn's earlier $15 plan, the plan page shows it as Legacy Pro, with 50 box-hours a month. Select **Move to Pro** to switch to Pro.
