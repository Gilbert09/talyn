import { JsonLd } from "@/components/seo/JsonLd";
import { site, pricing } from "@/lib/content";

/**
 * `Offer` schema, on the page the offer is actually on.
 *
 * It used to sit inside the home page's `SoftwareApplication`, which is a
 * reasonable place for it and a worse one than here: a rich result for a
 * price should take somebody to the prices. The home page keeps the
 * `SoftwareApplication` and `Organization` blocks and points its `offers` at
 * this URL instead.
 *
 * Both prices are emitted, not just the toggle's default. The prices are
 * derived from `pricing.tiers` rather than typed again — structured data that
 * disagrees with the visible table is the one kind of wrong Google will
 * cheerfully surface.
 */
function amount(price: string): number {
  return Number(price.replace(/[^0-9.]/g, ""));
}

export function OfferSchema() {
  const [free, paid] = pricing.tiers;
  const monthly = amount(paid.priceMonthly);
  const annualPerMonth = amount(paid.priceAnnual);

  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "Product",
        name: `${site.name} — ${paid.name}`,
        description: paid.blurb,
        url: `${site.url}/pricing`,
        brand: { "@type": "Brand", name: site.name },
        offers: [
          {
            "@type": "Offer",
            name: free.name,
            price: 0,
            priceCurrency: "USD",
            description: free.blurb,
            url: `${site.url}/pricing`,
            availability: "https://schema.org/InStock",
          },
          {
            "@type": "Offer",
            name: `${paid.name}, billed monthly`,
            price: monthly,
            priceCurrency: "USD",
            url: `${site.url}/pricing`,
            availability: "https://schema.org/InStock",
            priceSpecification: {
              "@type": "UnitPriceSpecification",
              price: monthly,
              priceCurrency: "USD",
              billingDuration: 1,
              billingIncrement: 1,
              unitCode: "MON",
            },
          },
          {
            "@type": "Offer",
            name: `${paid.name}, billed annually`,
            price: annualPerMonth * 12,
            priceCurrency: "USD",
            url: `${site.url}/pricing`,
            availability: "https://schema.org/InStock",
            priceSpecification: {
              "@type": "UnitPriceSpecification",
              price: annualPerMonth,
              priceCurrency: "USD",
              billingDuration: 12,
              billingIncrement: 1,
              unitCode: "MON",
            },
          },
        ],
      }}
    />
  );
}
