# Fleet Rebalancing Prototype: Planning Doc

Nov 20, 2026 · @A CV

## Problem framing

The three stakeholder quotes describe one decision problem: which mix of moves, pricing and inaction earns the most across the network, and what that mix does to each branch.

| Voice | What they said | What it is in the tool |
| --- | --- | --- |
| Regional ops / HQ | Decide centrally; moves cost money, idle days cost rentals | The objective: expected network contribution over the planning horizon |
| Revenue management | Pricing and incentives are cheaper than hauling | A second set of levers and a testable claim, checked on every solve |
| Branch manager | Losing even an idle truck hurts my numbers | Three different concerns, each handled in a different place (below) |

**The branch manager's complaint splits three ways**

| Concern | Example | Where it is handled |
| --- | --- | --- |
| A real operating loss | The truck would have served a local rental next week | Company economics: the solver already counts that lost rental |
| A performance attribution problem | HQ changes the fleet, but the branch's target stays the same | The branch scorecard layer, outside the objective |
| Missing operational information | The forecast omits a confirmed booking | Model inputs: the branch reports it and the plan is re-solved |

The product rule that follows: facts from a branch can change the plan, and scorecard discomfort cannot. Discomfort is answered with context and credits.

**Primary user:** the HQ regional ops lead, working a ranked action list for the next two weeks. The branch view and the revenue management view are secondary.

**What the prototype claims:** the best plan the solver found for this model, with the solver's status shown, under stated synthetic assumptions. It does not claim the result is right for a real business.

## Assumptions

Everything below is invented beyond the prompt and belongs in the write-up. All dollar figures are synthetic defaults, adjustable in the UI.

**Business**

1. The company wants to maximize network contribution: rental and fee revenue, less variable cost, incentive payments and transport cost.
2. A branch scorecard has two numbers: revenue and utilization. Utilization is rented truck-days divided by assigned fleet-days (assigned fleet times days in the period).
3. Under current rules a branch's assigned fleet does not change when HQ moves a truck. An idle truck leaving does not lower utilization by itself. The hit is the future rentals the branch can no longer serve against an unchanged target.
4. Rental revenue is booked at the origin branch. Drop-fee revenue is booked at the destination branch.
5. HQ sets rates, fees and incentives. Branch managers do not set prices.

**Time and scale**

6. A 14-day horizon in daily buckets. Dispatch decisions are made for days 1 to 5; the rest of the horizon shows their consequences.
7. Five branches in the Northeast US and two vehicle classes (16 ft box truck, 26 ft moving truck).
8. Every rental has a start day and a fixed duration: 2 days for local rentals, 3 days for one-way rentals.
9. Nothing is valued beyond day 14. Actions that pay off later are undervalued, and the write-up says so.

**Demand and bookings**

10. Demand comes in two kinds. Confirmed bookings have fixed prices and carry a penalty if unserved. New demand is a forecast that responds to price.
11. An unserved confirmed booking is reported as a broken commitment and carries a $1,000 penalty, which discourages breaking it. A sufficiently large contribution gain can outweigh the penalty.
12. New demand has three scenarios (low, base, high at 80%, 100% and 120% of forecast, weighted 25/50/25). The plan is fixed across scenarios; rentals served adapt to what shows up.

**Levers**

13. Rate tiers per branch and class apply to new local rentals: −20%, −10%, 0, +10%, with constant elasticity (default −1.2; −1.8 at Portland).
14. Drop-fee tiers per destination branch apply to new one-way rentals into it: +$0, +$50, +$100. A fee deters a share of them. Of those deterred, a share books to the nearest other branch and the rest do not rent.
15. Return-incentive tiers per branch apply to confirmed one-way rentals due back at its nearest neighbor: $0, $40 or $80 paid per customer who returns here instead. Uptake is voluntary and modeled at its expected share.
16. Each rental is affected by exactly one lever. One-way rentals are not affected by the origin's rate tier.
17. Any price, fee or incentive change carries a $50 change cost, so the solver does not make changes for negligible gains.
18. Moves are charged at full cost when dispatched. The solver chooses the mode. Staff drive: arrives next day, up to 150 miles, at most 2 per branch per day. Hauler: arrives in 2 days, any distance.

## Optimization model

One mixed-integer program chooses moves, rate tiers, fee tiers and incentive tiers together, on a daily vehicle schedule where every rental is counted once.

**The shared unit: a rental cohort**

A cohort is a group of identical rentals: origin, destination, class, start day and duration. Local rentals have the same origin and destination. Each rental the model fulfills generates, exactly once:

1. Its revenue, including any fee.
2. Its variable cost.
3. A truck leaving the origin on the start day.
4. A truck arriving at the destination when the rental ends.

A rental that a fee deters is never fulfilled, so its revenue, cost, departure and return all disappear together. No lost margin is subtracted separately.

**Sets**

- Branches (5), classes (2), days (14), demand scenarios (3), transport modes (2)
- Rate tiers (4), fee tiers (3), incentive tiers (3)

**Decisions**

| Variable | Type | Meaning |
| --- | --- | --- |
| Moves by lane, class, mode and dispatch day | Integer ≥ 0 | Trucks relocated; dispatch days 1 to 5 only |
| Rate tier per branch and class | Binary, one chosen | Price change on new local rentals |
| Fee tier per destination branch | Binary, one chosen | Drop fee on new one-way rentals into the branch |
| Incentive tier per branch | Binary, one chosen | Payment offered to redirect confirmed returns here |
| Rentals fulfilled per cohort, tier and scenario | Continuous ≥ 0 | What is actually served |
| Trucks available per branch, class, day and scenario | Continuous ≥ 0 | The daily schedule |
| Broken commitments per scenario | Continuous ≥ 0 | Confirmed bookings not served |

**Objective**

```latex
\max \; \sum_{s} \pi_s \sum_{c} (R_c - V_c)\, f_{cs} \;-\; \sum_{\text{moves}} c_{ijm}\, x_{ijkmd} \;-\; \text{incentive payments} \;-\; \kappa \cdot (\text{tiers changed}) \;-\; M \sum_{s} \pi_s\, u_s
```

- π is the scenario weight, R and V the revenue and variable cost of one rental in cohort c, and f the rentals fulfilled.
- c is the full cost of one move on mode m, charged once.
- κ is the $50 change cost and M the $1,000 broken-commitment penalty. Penalties are reported separately from contribution.

**Constraints**

1. **Daily balance.** Trucks available tomorrow equal trucks available today, minus rentals starting, minus moves dispatched, plus rentals ending, plus moves arriving. This holds per branch, class and scenario.
2. **Demand.** New rentals fulfilled cannot exceed forecast demand at the chosen tier. Because each cohort is affected by one lever, this is a constant times one binary.
3. **Commitments.** Confirmed bookings fulfilled plus broken commitments equal confirmed bookings.
4. **Diversion.** A fee tier creates a diverted cohort to the nearest other branch, sized from the deterred demand. It pays no fee there.
5. **Redirected returns.** An incentive tier moves its expected uptake share of eligible confirmed returns from the neighbor to this branch on the same day.
6. **Transport.** Staff drives only on lanes up to 150 miles, at most 2 per branch per day. Arrival is dispatch day plus 1 (staff) or plus 2 (hauler).

**What the timing buys:** a truck arriving Friday cannot cover a Wednesday shortage, two overlapping bookings cannot share one truck, and a truck promised to a confirmed booking cannot be moved away.

**Size and solver:** up to about 10,000 continuous variables, 70 binaries and 400 integers. Use HiGHS in-process with a 5-second time limit. Report status (optimal, time limit, infeasible) and the optimality gap with every result. Benchmark one full solve before building the UI.

**Strategies:** the same model runs four times with levers switched off: do nothing, moves only, pricing only, joint. All four use the same bookings and scenarios.

## Branch layer

Branch incentives never enter the objective. This layer reports what the plan does to each branch, offers one illustrative adjustment policy, and gives branches a way to correct the facts.

**1. Actual impact, shown first**

For each branch, the change against do nothing under current scorecard rules: revenue, rented truck-days and utilization. Nothing is adjusted here.

**2. Adjusted scorecard (illustrative hold-harmless policy)**

|  | Current rules | Adjusted rules |
| --- | --- | --- |
| Assigned fleet-days | Fixed for the horizon | Follow the truck: the donor's assignment drops on dispatch and the receiver's rises on arrival. Transit days sit in a central account |
| Revenue | Actual revenue booked | Actual revenue plus a whole-plan performance credit |

- **The credit:** a branch whose revenue under the plan is below its revenue in the do-nothing baseline is credited the difference. It is calculated once per plan, against the baseline solved from the same inputs.
- **Who pays:** a central HQ rebalancing account. Receiving branches are not charged, so no receiver is pushed below its baseline by another branch's credit.
- **One credit only.** It covers the whole plan's effect on the branch, including moves, fees and price changes. There is no separate fee credit, so nothing is credited twice.
- **No share of the uplift** goes to the donor.

**Invariants (unit tests)**

1. Changing the credit policy leaves company contribution unchanged.
2. Actual branch revenues sum to network revenue.
3. Adjusted branch revenues equal network revenue plus the central account's total credits.

**What the adjustment does not fix.** The doc and the UI should say this plainly:

- It protects revenue against the baseline. It does not protect utilization.
- A receiving branch can earn more and still see utilization fall, because its assigned fleet-days grow faster than its rentals.
- Credited revenue is scorecard accounting. Total credited revenue exceeds actual revenue by the central account's balance.
- The claim is that the policy removes one reason to resist a move, not every reason.

**3. Operational feedback**

A branch manager can report a missing confirmed booking: class, start day, duration and destination. The booking becomes a commitment, the plan is re-solved, and the interface lists which actions changed. If the plan does not change, it shows that the remaining fleet still covers the booking.

A scorecard objection has no such input. It is answered by the two scorecards above.

## Explaining the decision

Every number in an explanation comes from a solve of the same model, and each is labeled with the exact question it answers.

| Output | Label in the UI | How it is computed | When |
| --- | --- | --- | --- |
| Strategy comparison | Expected contribution by strategy | Four solves on the same inputs: do nothing, moves only, pricing only, joint | Every solve |
| Contribution bridge | Plan against do nothing | Changes in rental revenue, fee revenue and variable cost, then incentive payments, transport cost and change costs, summing to the net change | Every solve |
| Horizon split | Week 1 and week 2 contribution | The same totals summed by day | Every solve |
| Downside view | The plan in low, base and high demand | The plan's contribution in each scenario beside do nothing in the same scenario | Every solve |
| Action counterfactual | Reduction in plan value after replanning without this action | Re-solve with the action forbidden | When its detail view opens |
| Transfer detail | What this transfer does | Donor rentals lost, receiver rentals gained, arrival day against shortage day, cost and mode | With the counterfactual |
| Solver status | Best plan found, and whether it is proven optimal | Status and gap from the solver | Every solve |

**What "forbidden" means.** For a move, that lane and class is closed for the dispatch window. For a rate, fee or incentive change, that tier is held at base. The detail view states which.

**What the counterfactual is not.** It is not a share of the plan's profit. Two actions that only work together will each show the full loss, and an action with an equally good substitute will show zero. The bridge is the only breakdown that sums to the total.

**Why sentence.** Each action gets one sentence generated from its transfer detail, for example: "Drive 2 box trucks Hartford to New Haven on Tuesday: they arrive Wednesday, before Thursday's shortage, and a hauler would arrive too late."

**Sensitivity.** Sliders for elasticity, fee deterrence, incentive uptake and move cost re-solve the four strategies. This answers a different question from the downside view: what would be recommended if an assumption were different.

**Stretch: incentive first, haul if needed.** One scripted comparison for a single shortage, not a solver feature:

1. **Haul now:** dispatch the move on day 1.
2. **Incentive first:** offer the return incentive on day 1. On day 3, observe uptake. If it is short, dispatch a staff drive by day 4 so it arrives by day 5, if a driver is available.

The policy's value is the uptake probability times the outcome with high uptake, plus the remainder times the outcome with low uptake and the fallback. That takes three solves with the day-1 decisions fixed. The fallback uses only what is known on day 3.

## Synthetic data

One seeded dataset with five branches, plus small variants that each force a specific behavior. The outcomes below are targets to tune toward after the first run, not results.

| Branch | Role in the scenario |
| --- | --- |
| New York City, NY | Largest demand; one-way moving trucks drain outward |
| Boston, MA | High demand; drains toward Portland |
| Hartford, CT | Idle box trucks accumulate |
| New Haven, CT | Short of box trucks midweek; about 40 miles from Hartford |
| Portland, ME | Accumulates moving trucks; low local demand; far from New York |

**Cases to build**

| Case | What it should show |
| --- | --- |
| Hartford to New Haven | A short transfer wins, and only the faster mode arrives in time |
| Portland | Pricing wins because hauling back is expensive |
| Hartford reports a missing booking | A branch correction changes the plan |
| High move cost variant | No intervention is worthwhile, and the tool recommends none |
| Pricing adds nothing | A variant where pricing is unattractive, so the tool recommends moves and leaves prices alone: using both levers earns no more than moves on their own |

**Generated fields**

- Branch coordinates, with lane distance as straight-line miles times a 1.2 road factor.
- Starting inventory and assigned fleet per branch and class.
- Confirmed bookings with start day, duration and destination.
- Forecast new demand per cohort, scaled for the low, base and high scenarios.

**Default parameters (all synthetic)**

| Parameter | Default |
| --- | --- |
| Daily rate: 16 ft box / 26 ft moving | $110 / $160 |
| Variable cost per rented day | 15% of base rate |
| Hauler cost per truck | $150 load fee + $2.50 per mile |
| Staff drive cost per truck | $35 per hour labor + $0.80 per mile, including the return trip |
| Rate elasticity | −1.2 network-wide; −1.8 at Portland |
| New one-way rentals deterred at +$50 / +$100 fee | 15% / 30% |
| Deterred rentals that book to the nearest branch | 40% |
| Return-incentive uptake at $40 / $80 | 25% / 50% |
| Change cost per price, fee or incentive change | $50 |
| Broken-commitment penalty | $1,000 |

**Pricing defaults.** At an elasticity of −1.2 and 15% variable cost, a 10% discount raises contribution by about 0.1% where capacity is idle, and a 20% discount lowers it. At most branches discounts will rarely be chosen, and pricing acts through fees, incentives and the +10% tier where trucks are scarce. Portland is set to −1.8 as a price-sensitive, low-demand market, where a 20% discount raises contribution on idle capacity by about 14%. Check the first results before scripting the Portland case.

## Dashboard

One page with three views and a persistent assumptions panel. The network view is the default and carries the demo.

**1. Network view (HQ ops, primary)**

- Headline: expected contribution of the joint plan against do nothing over 14 days, with the week 1 and week 2 split and the solver status.
- Strategy comparison: four bars.
- Contribution bridge from do nothing to the plan.
- Downside view: the plan and do nothing in low, base and high demand.
- Action list: moves with dispatch day, arrival day and mode; rate, fee and incentive changes. Each row has its why sentence and the branches it affects.
- Broken commitments, if any, shown above everything else.

**2. Action detail (opens from a row, computed on open)**

- Transfer detail: donor rentals lost, receiver rentals gained, arrival against shortage day, cost and mode.
- Reduction in plan value after replanning without this action, with what was forbidden.
- Affected branches: actual impact and adjusted scorecard.

**3. Branch view (branch manager)**

- What the plan asks of this branch, with dates.
- Actual impact against do nothing under current rules.
- Adjusted scorecard, with the credit line and the central account that funds it.
- "Report a missing booking" form. Submitting re-solves and lists what changed in the plan.

**Assumptions panel (always visible)**

- Sliders: elasticity, fee deterrence, incentive uptake, move cost multiplier.
- A plain list of the modeling assumptions from this doc.

**Stretch, in order:** the incentive-first comparison card, then a table of the network value of one additional truck starting at each branch.

## Architecture, API and tests

A stateless Python service solves on request and a React single-page app renders the result. There is no database.

**Backend (Python, FastAPI)**

| Module | Responsibility |
| --- | --- |
| `data.py` | Seeded generator: branches, fleet, confirmed bookings, demand cohorts, scenario scaling, case variants |
| `model.py` | Builds and solves the program, with flags to switch levers off, forbid an action or fix day-1 decisions |
| `explain.py` | Strategy comparison, contribution bridge, downside view, action counterfactual, why sentences |
| `scorecard.py` | Actual branch impact and the adjusted scorecard with its central account |
| `main.py` | FastAPI routes and an in-memory cache keyed by parameters and bookings |

**Endpoints**

| Route | Returns |
| --- | --- |
| `GET /api/scenario` | Branches, classes, inventory, bookings, demand, default parameters |
| `POST /api/solve` | Takes parameter overrides and added bookings. Returns the four strategy totals with solver status, the joint plan's actions, the bridge, per-scenario outcomes and both branch scorecards |
| `POST /api/explain/action` | Takes one action. Returns the replanned value without it and the transfer detail |
| `POST /api/conditional` | Stretch. Returns the haul-now and incentive-first policy values |

**Frontend (React, Vite, TypeScript)**

- One page, three views as tabs, assumptions panel as a sidebar.
- One charting library for the strategy bars, the bridge and the downside view.
- Sliders debounce and call `POST /api/solve`. The plan diff after a branch correction is computed in the browser from the two action lists.

**Tests**

| Test | Required behavior |
| --- | --- |
| A confirmed booking needs the truck a transfer would take | The transfer is not made, or the booking is covered another way. No broken commitments |
| A transfer can only arrive after the demand it targets | It earns nothing from that demand and is not chosen |
| The credit policy changes | Company contribution is unchanged |
| Every intervention costs more than it creates | The plan has no actions |
| Vehicle conservation | Available, rented and in-transit trucks sum to the fleet on every day |
| Joint against restricted strategies | Joint is at least as good as each. This is a bug check, not validation |

## Trade-offs and known limitations

Each choice below buys a 3-hour build at a stated cost. These are the points an evaluator is most likely to probe.

| Choice | What it buys | What it costs |
| --- | --- | --- |
| Daily schedule with rental cohorts | Feasible plans, protected bookings, and revenue tied to vehicle movement | A larger model and the biggest share of the build time |
| Five branches and two classes | Room for the timing model | A thinner network than a real region |
| Fixed rental durations | A simple daily balance | No long rentals, early returns or late returns |
| 14-day horizon, full move cost, no value after day 14 | A headline that is real money over a stated period | Moves that pay off after day 14 look worse than they are |
| One lever per rental | A linear model with no price interactions | The origin's rate does not affect one-way demand, which is unrealistic |
| Discrete price tiers | Fast solves and a visible menu of options | The true optimum may sit between tiers |
| Three demand scenarios | A downside view from the same solve | An illustration, not a calibrated distribution; only demand is uncertain |
| Expected incentive uptake in the main model | No multi-stage optimization | Uptake risk appears only in the scripted comparison |
| Conditional plan as a scripted comparison | The "try pricing, then haul" idea shown with honest timing | One hand-built case, and first on the cut list |
| Central account for credits | No receiving branch is penalized | Credited revenue exceeds actual revenue; utilization is not protected |
| Incentives outside the objective | The plan is best for the network and the conflict is visible | Assumes HQ can change scorecard rules |
| Engineered scenario | A demo where the levers disagree | Shows the reasoning, not the size of the benefit |

**Not modeled:** competitor pricing, substitution between vehicle classes, maintenance downtime, hauler batching discounts, new fleet purchases, and the effect of price changes on repeat business.

## Build order and time budget

This revision is tighter than the first draft: the model takes 55 of the 180 minutes and there is no slack. The plan holds only if the four strategies solve by minute 70.

| Minutes | Block | Done when |
| --- | --- | --- |
| 0–15 | Scaffold; `data.py` with branches, bookings and cohorts | The scenario prints as a Python dict |
| 15–70 | `model.py`: daily balance, cohorts, tiers, moves by mode, strategy flags | Four strategy totals print with solver status; one full solve is timed |
| 70–85 | `scorecard.py`, bridge, downside view, the first four tests | Tests pass |
| 85–100 | FastAPI: scenario, solve, explain/action | Endpoints return JSON |
| 100–135 | Network view | The demo's main screen works end to end |
| 135–150 | Branch view with the missing-booking form; action detail | A reported booking re-solves and shows the change |
| 150–165 | Standalone one-page write-up, drawn from this doc | Assumptions and trade-offs are readable without the demo |
| 165–180 | Record the demo | One take plus one retake |

**Gate at minute 70.** If the four strategies are not solving, drop return incentives and the low and high scenarios immediately and move on.

**Cut list, in order**

1. Network value of an additional truck (stretch; never start unless ahead).
2. Incentive-first comparison (stretch).
3. Action counterfactual on click. Keep the bridge and transfer detail.
4. Return incentives as a lever.
5. Low and high scenarios, which removes the downside view.

**Do not cut**

- Daily timing and booking protection.
- Full-cost economics.
- The four-strategy comparison.
- The missing-booking correction.
- Actual branch impacts beside the adjusted scorecard.

**Demo script (about 5 minutes)**

1. The problem, the three voices, and the branch complaint split three ways.
2. Network view: do nothing against joint, the strategy bars and the bridge.
3. Open the Hartford to New Haven transfer: dates, mode and why.
4. Hartford's branch view: the actual hit, then the adjusted scorecard and what it does not fix.
5. Hartford reports a missing booking. The plan re-solves and changes.
6. Portland: pricing chosen over hauling.
7. Downside view and assumptions. Show the incentive-first comparison if it was built.

## Decisions

No questions are open. The five from the last round were settled on the recommended option, chosen for the strongest demo that fits the time.

**Settled in this round**

- **Time limit:** 3 hours is treated as hard and includes the write-up and recording.
- **Incentive-first comparison:** stays a stretch item and is the first one built if the branch view is done before minute 150. The core demo does not depend on it.
- **Credits:** funded from a central HQ rebalancing account. Receiving branches are not charged.
- **Rental durations:** fixed at 2 days local and 3 days one-way.
- **Portland elasticity:** set to −1.8 from the start, declared as an assumption, so pricing has a real case to win.

**Settled since the first draft**

- The persistence factor is gone. Moves are charged at full cost over a 14-day horizon.
- Drop-fee revenue is booked at the destination branch, as a declared assumption.
- The one-truck safety floor is gone. Confirmed bookings protect service.
- Price changes are limited by a $50 change cost, not a cap.
- The write-up is a standalone one-page document.

## Changes from the first draft

| Area | First draft | This revision |
| --- | --- | --- |
| Time | One weekly period in truck-days | 14 days in daily buckets with dated rentals |
| Demand and flows | Rental demand and one-way flows modeled separately | One rental cohort generates revenue, cost, departure and return |
| Bookings | A one-truck floor | Confirmed bookings as commitments |
| Pricing levers | Rates and drop fees | Rates, drop fees and return incentives |
| Move economics | Cost divided by a 2-week persistence | Full cost, 14-day horizon, week 1 and 2 shown |
| Transport mode | Cheaper mode chosen in advance | Solver chooses by outcome |
| Branch complaint | A scorecard problem | Three concerns handled in three places |
| Credits | Charged to receivers by trucks received | One whole-plan credit from a central account, labeled illustrative |
| Branch view | Read-only | Missing-booking report that re-solves |
| Explanations | "Value of each action", payback days, marginal truck value | Bridge, relabeled counterfactual on click, downside view |
| Scale | 8 branches, 3 classes, 15 demand samples | 5 branches, 2 classes, 3 scenarios |
| Removed |  | Map, elasticity sweep chart, payback days |
