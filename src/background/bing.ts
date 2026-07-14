interface BingConfig {
  IG: string;
  IID: string;
  key: number;
  token: string;
  tokenTs: number;
  tokenExpiryInterval: number;
  subdomain?: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0";
const BING_WEBSITE = "https://bing.com/translator";
const MAX_RETRIES = 2;

let config: BingConfig | undefined;
let configPromise: Promise<BingConfig> | undefined;

async function fetchConfig(): Promise<BingConfig> {
  let subdomain: string | undefined = config?.subdomain;
  const url = subdomain
    ? `https://${subdomain}.bing.com/translator`
    : BING_WEBSITE;

  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
  });

  const finalUrl = resp.url;
  const subMatch = finalUrl.match(/^https?:\/\/(\w+)\.bing\.com/);
  if (subMatch) {
    subdomain = subMatch[1];
  }

  const html = await resp.text();

  const igMatch = html.match(/IG:"([^"]+)"/);
  const iidMatch = html.match(/data-iid="([^"]+)"/);
  const abuseMatch = html.match(
    /params_AbusePreventionHelper\s?=\s?([^\]]+\])/
  );

  if (!igMatch || !iidMatch || !abuseMatch) {
    throw new Error("Failed to extract Bing translator config");
  }

  const IG = igMatch[1];
  const IID = iidMatch[1];
  const [key, token, tokenExpiryInterval] = JSON.parse(abuseMatch[1]);

  return (config = {
    IG,
    IID,
    key,
    token: String(token),
    tokenTs: key,
    tokenExpiryInterval,
    subdomain,
  });
}

function isTokenExpired(): boolean {
  if (!config) return true;
  return Date.now() - config.tokenTs > config.tokenExpiryInterval;
}

async function ensureConfig(): Promise<BingConfig> {
  if (!configPromise) {
    configPromise = fetchConfig();
  }
  await configPromise;
  if (isTokenExpired()) {
    configPromise = fetchConfig();
    await configPromise;
  }
  return config!;
}

export async function bingTranslate(
  text: string,
  to: string = "zh-Hans"
): Promise<string> {
  const cfg = await ensureConfig();

  const apiUrl = `https://${cfg.subdomain ? cfg.subdomain + "." : ""}bing.com/ttranslatev3?isVertical=1&IG=${cfg.IG}&IID=${cfg.IID}`;

  const body = {
    fromLang: "auto-detect",
    to,
    text,
    token: cfg.token,
    key: cfg.key,
    tryFetchingGenderDebiasedTranslations: true,
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: `https://${cfg.subdomain ? cfg.subdomain + "." : ""}bing.com/translator`,
        },
        body: new URLSearchParams(body as Record<string, string>),
      });

      if (resp.status === 401 || resp.status === 429) {
        configPromise = fetchConfig();
        await configPromise;
        throw new Error(`Bing API rate limited (${resp.status})`);
      }

      if (!resp.ok) {
        throw new Error(`Bing API error: ${resp.status}`);
      }

      const contentType = resp.headers.get("content-type") || "";
      const rawText = await resp.text();

      if (contentType.includes("application/json")) {
        const data = JSON.parse(rawText);
        const translation = data[0]?.translations?.[0]?.text;
        if (translation) return translation;
      }

      // Non-JSON response: might be gender-debiased HTML or captcha
      if (rawText.includes("ShowCaptcha")) {
        throw new Error("Bing captcha triggered");
      }

      // Gender debiasing: re-request with flag
      body.isGenderDebiasViewPresent = true;
      const gdResp = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: `https://${cfg.subdomain ? cfg.subdomain + "." : ""}bing.com/translator`,
        },
        body: new URLSearchParams(body as Record<string, string>),
      });

      if (gdResp.ok) {
        const gdData = await gdResp.json();
        return gdData.masculineTranslation || gdData.translations?.[0]?.text || "";
      }

      return "";
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  throw lastError ?? new Error("Bing translation failed");
}
