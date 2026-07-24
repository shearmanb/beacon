// Browser identity profiles. Bundled so UA and matching Sec-CH-UA headers stay
// consistent. Firefox and Safari don't send Sec-CH-UA, so those profiles omit
// those fields.

export interface BrowserProfile {
  ua: string;
  [header: string]: string;
}

export const BROWSER_PROFILES: readonly BrowserProfile[] = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Sec-CH-UA": '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="99"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Sec-CH-UA": '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="99"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"macOS"',
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0",
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15",
  },
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Sec-CH-UA": '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="99"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Linux"',
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0",
    "Sec-CH-UA": '"Chromium";v="136", "Microsoft Edge";v="136", "Not-A.Brand";v="99"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
  },
];

// en-US variants only: the egress IP is US and the operator is US — an en-GB
// primary language from a US IP is a needless coherence break (audit W6).
export const ACCEPT_LANGUAGES: readonly string[] = [
  "en-US,en;q=0.9",
  "en-US,en;q=0.8",
  "en-US,en;q=0.9,es;q=0.8",
  "en-US,en;q=0.7",
];
