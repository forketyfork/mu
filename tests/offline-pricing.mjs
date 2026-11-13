import { PricingCatalog } from '../src/pricing.mjs';

// App tests use this catalog so that starting Mu never downloads LiteLLM prices.
export function offlinePricing() {
  const catalog = Object.assign(
    new PricingCatalog({
      fetch: async () => {
        catalog.fetches += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ 'gpt-test': { input_cost_per_token: 0.000001, output_cost_per_token: 0.00001 } }),
        };
      },
    }),
    { fetches: 0 },
  );
  return catalog;
}
