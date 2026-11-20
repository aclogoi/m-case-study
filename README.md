# Fleet rebalancing

A regional operations lead has five days to dispatch trucks across five Northeast branches. Sending a truck to a busier location can earn another rental, but moving it costs money and can leave its home branch short. This prototype helps the lead decide **what to move, where to change prices, and when to leave the fleet alone**. Approved decisions become a dispatch sheet and a set of pricing instructions.

## From stakeholder disagreement to a decision

| What the stakeholder cares about | How it changes the product |
| --- | --- |
| HQ wants fewer idle trucks across the network. | Compare plans by expected network contribution over two weeks, including rental income, operating costs and transport. An idle truck can stay put when moving it costs too much. |
| Revenue management believes pricing is cheaper than hauling. | Compare four strategies on the same demand forecast. Doing nothing, moving trucks, changing pricing, and combining both each get a modeled dollar outcome. |
| Hartford worries that releasing trucks will hurt its numbers. | Count lost local rentals in network economics. Show the effect of HQ decisions on the branch scorecard. Give the manager a way to report a confirmed booking missing from the forecast and rebuild the plan. |

## Try the Hartford decision

Run the live prototype from the repository root with Python and uv for the backend and Node.js and npm for the frontend. In one terminal run

```sh
cd backend
uv run uvicorn app.main:app --port 8010
```

In a second terminal run

```sh
cd frontend
npm ci
npm run dev
```

Open [the local app](http://localhost:5173). It starts on the main network.

1. In **Situation**, compare the proposed plan with doing nothing. In **Decisions**, find the Hartford-to-New Haven box truck moves. Leave them pending so the planner can reconsider them.
2. Open **Branches**, select **Hartford**, then choose **Use suggested example**. The manager has a confirmed local booking for three 16-foot trucks for two days starting on day three. Choose **Report booking and rebuild the plan**.
3. Inspect the changed actions. Hartford now sends **two box trucks to New Haven across the dispatch window instead of three**. The booking changes what HQ should do even though the network still benefits from moving trucks.
4. Return to **Decisions**, approve a revised Hartford transfer, then open **Hand-off**. Find its origin, destination and truck count on the dispatch sheet. The remaining recommendations still await a decision.

### What the example is worth

| Expected network value over two weeks | Original forecast | With Hartford booking |
| --- | ---: | ---: |
| Do nothing | $95,419 | $95,741 |
| Recommended plan | $100,866 | $100,740 |
| Gain over doing nothing | **$5,447** | **$4,999** |

These rounded estimates come from the live solver with synthetic demand, default costs and no approvals or rejections. Compare the two plans **within each column**. The booking changes both the revenue available and the trucks available to serve other customers. The business value of the correction is catching an outdated dispatch recommendation before approval.

Confirmed bookings carry a modeled $1,000 penalty per unserved booking unit. A sufficiently profitable alternative can outweigh that penalty. The prototype surfaces broken commitments for review.

See the [planning document](<docs/Fleet Rebalancing Prototype Planning Doc (1).md>) for assumptions, branch accounting and model design, or the [API contract](docs/API_CONTRACT.md) for implementation details.
