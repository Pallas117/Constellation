// Synthetic stand-ins for the members' opportunity feeds: the same shapes as the Spaceflight News API, UKRI's
// opportunity RSS, the UK Space Agency's GOV.UK Atom feed and a published Google Sheets CSV tab, but every
// title, organiser and link is an example. Dates are relative to `now`, so the fixtures never go stale.
const DAY = 86_400_000;
const at = (now, days) => new Date(now + days * DAY).toISOString();
const date = (now, days) => at(now, days).slice(0, 10);
const rfc822 = (now, days) => new Date(now + days * DAY).toUTCString().replace("GMT", "+0000");

/** A published-CSV link of the right shape (the Worker only accepts Google's "Publish to web" CSV links). */
export const PROGRAMMES_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-example-public-programmes-tab/pub?gid=0&single=true&output=csv";

export const newsJson = (now) => ({
  count: 3,
  results: [
    { id: 1, title: "Example LEO operator raises a seed round", url: "https://news.example.test/leo-seed", news_site: "Example Space News", summary: "Not kept.", published_at: at(now, -0.2) },
    { id: 2, title: "Example agency opens a lunar data challenge", url: "https://news.example.test/lunar-challenge", news_site: "Example Orbit Daily", published_at: at(now, -1) },
    { id: 3, title: "Not a link we show", url: "javascript:alert(1)", news_site: "Bad", published_at: at(now, -1) },
  ],
});

export const ukriXml = (now) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>UKRI opportunities</title>
<item><title>Example: satellite data for flood resilience</title><link>https://www.ukri.org/opportunity/example-satellite-flood-resilience/</link>
<pubDate>${rfc822(now, -3)}</pubDate><category><![CDATA[Innovate UK]]></category>
<description><![CDATA[UK businesses and start-ups can apply for a share of up to &pound;1 million to use Earth observation data.<br /><p aria-label="Councils"><span style="padding: 2px 5px">Innovate UK</span> </p>]]></description></item>
<item><title>Example: clinical trials network</title><link>https://www.ukri.org/opportunity/example-clinical-trials/</link>
<pubDate>${rfc822(now, -2)}</pubDate><category><![CDATA[MRC]]></category><description><![CDATA[A medical research network, so it is left out.]]></description></item>
<item><title>Example: old space call</title><link>https://www.ukri.org/opportunity/example-old-space/</link>
<pubDate>${rfc822(now, -90)}</pubDate><category><![CDATA[STFC]]></category><description><![CDATA[Space research, but posted too long ago.]]></description></item>
<item><title>Example: space call elsewhere</title><link>https://elsewhere.example.test/space</link>
<pubDate>${rfc822(now, -1)}</pubDate><category><![CDATA[STFC]]></category><description><![CDATA[Space research on another site, so it is left out.]]></description></item>
</channel></rss>`;

export const uksaAtom = (now) => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>UK Space Agency - Activity on GOV.UK</title>
<entry><id>https://www.gov.uk/example-1</id><updated>${at(now, -1)}</updated><link rel="alternate" type="text/html" href="https://www.gov.uk/government/publications/example-student-hackathon-call"/>
<title>Guidance: Example student hackathon call</title><category label="Guidance" term="Guidance"/><summary>Example.</summary></entry>
<entry><id>https://www.gov.uk/example-2</id><updated>${at(now, -1)}</updated><link rel="alternate" type="text/html" href="https://www.gov.uk/government/news/example-mission-news"/>
<title>Example mission puts UK expertise to work</title><category label="News story" term="News story"/><summary>Not a call, so it is left out.</summary></entry>
</feed>`;

export const programmesCsv = (now) => [
  "Programme,Type,Organiser,Deadline,Indicative value (verify),Who can apply (verify),Region,What you get,Official URL",
  `Example Space Accelerator,Accelerator,Example Ventures,${date(now, 10)},"Up to $100,000","Early-stage space startups, ""seed"" or earlier",Global,Mentoring and investment,https://accelerator.example.test/apply`,
  `Example Student Hackathon,Hackathon,Example Agency,${date(now, 30)},Prizes,University students and graduates,UK,"A weekend of AI and Earth observation challenges",https://hackathon.example.test/`,
  `Example Business Incubation Centre,Incubator,Example Agency,Rolling,Incubation support,Founders of UK space startups,UK,Business incubation,https://incubation.example.test/`,
  `Example closed grant,Grant,Example Council,${date(now, -5)},£50k,Researchers,UK,Research funding,https://grant.example.test/`,
  `Example without a link,Grant,Example Council,${date(now, 20)},£10k,Anyone,UK,Nothing,`,
  `Example bad link,Grant,Example Council,${date(now, 20)},£10k,Anyone,UK,Nothing,javascript:alert(1)`,
].join("\r\n");
