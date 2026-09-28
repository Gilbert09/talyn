import { JsonLd } from "@/components/seo/JsonLd";
import { site, pricing } from "@/lib/content";

/**
 * `Organization` and `SoftwareApplication` for the home page.
 *
 * The prices are derived from `pricing` rather than typed again, because a
 * structured-data price that disagrees with the pricing table is the one kind
 * of wrong Google will happily show in a result. Stripping the leading "$"
 * is the only transform: the copy is written for a human ("$15", "$12.50")
 * and schema.org wants a bare number next to a currency code.
 *
 * `offers` is an `AggregateOffer` over the free and paid tiers. The annual
 * price is the low end because it is the real floor per month; the monthly
 * price is the high end.
 */
function amount(price: string): number {
  return Number(price.replace(/[^0-9.]/g, ""));
}

export function HomeSchema() {
  const paid = pricing.tiers.find((t) => t.highlighted) ?? pricing.tiers[1];

  return (
    <JsonLd
      data={[
        {
          "@context": "https://schema.org",
          "@type": "Organization",
          name: site.name,
          url: site.url,
          description: site.description,
          sameAs: [site.githubUrl],
        },
        {
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: site.name,
          applicationCategory: "DeveloperApplication",
          operatingSystem: "macOS, Windows, Linux, Web",
          url: site.url,
          description: site.description,
          offers: {
            "@type": "AggregateOffer",
            priceCurrency: "USD",
            lowPrice: 0,
            highPrice: amount(paid.priceMonthly),
            offerCount: pricing.tiers.length,
            offers: pricing.tiers.map((tier) => ({
              "@type": "Offer",
              name: tier.name,
              price: amount(tier.priceMonthly),
              priceCurrency: "USD",
              description: tier.blurb,
            })),
          },
        },
      ]}
    />
  );
}
