# Sunday — Terms of Service

**Last updated: October 8, 2026**

These Terms of Service ("Terms") govern your use of the Sunday IDE software and the optional Sunday hosted gateway service. By installing Sunday or using the hosted gateway, you agree to these Terms.

## 1. What Sunday is

Sunday is a **free, open-source AI coding IDE**, licensed under the **Apache License 2.0**. The full source code is available at [github.com/Vivek492005/Sunday](https://github.com/Vivek492005/Sunday). Your rights to the software itself — to use, modify, and distribute it — are governed by the Apache-2.0 license, not by this document.

These Terms cover the **optional hosted gateway** (`https://sunday-final-ide.onrender.com`), a free service that provides AI model access without requiring you to configure your own API keys.

## 2. Two ways to use Sunday

- **Bring your own key (BYOK) / local models.** You can use Sunday entirely with your own provider API keys (OpenRouter, Groq) or a local model server. This requires **no account, no sign-in**, and these Terms' gateway sections do not apply to that usage — your relationship is directly with your chosen provider under their terms.
- **Hosted gateway (zero-config).** Sign in with GitHub, Google, or Microsoft and get free AI access (currently **200 requests per day**, resetting at UTC midnight) with no API key setup. Sections 3–7 below apply to this service.

## 3. Acceptable use of the hosted gateway

The free tier exists so anyone can try Sunday. To keep it available for everyone:

- **No abuse.** Do not attempt to circumvent rate limits or quotas (e.g. creating multiple accounts to pool quota), probe the service for vulnerabilities without permission, or use the service to harm, harass, or deceive others.
- **No reselling.** You may not resell, repackage, or charge others for access to the hosted gateway.
- **No unlawful content.** Do not use the service to generate or distribute content that is illegal in your jurisdiction, including CSAM, malware, or instructions facilitating wrongdoing.
- **Automated access.** Scripted or bot access is allowed within your quota, but aggressive polling, scraping, or denial-of-service behavior will be rate-limited or blocked.

We may throttle, suspend, or terminate accounts that violate this section, with or without prior notice for egregious abuse.

## 4. Accounts

- You sign in with an existing GitHub, Google, or Microsoft account via OAuth. You are responsible for keeping those accounts secure.
- One person per account. Sharing credentials to pool free-tier quota is a violation of Section 3.
- Signing out of Sunday revokes both your OAuth access and refresh tokens on our side.

## 5. Service availability — no SLA

The hosted gateway is a **best-effort free service**:

- We aim for high availability but make **no uptime guarantees** and offer **no service-level agreement**.
- The free tier runs on shared infrastructure that may spin down when idle; the first request after idle may take up to ~60 seconds.
- Quota limits, available models, and the list of supported OAuth providers may change at any time. We will announce material reductions in the GitHub repository.
- The IDE itself (BYOK/local mode) is unaffected by gateway outages — your editor and agent keep working with your own keys.

## 6. AI-generated output

AI models can make mistakes. Code, text, or suggestions produced through Sunday — whether via the hosted gateway or your own keys — should be reviewed before use, especially in production systems. We are not responsible for defects, security issues, or losses arising from AI-generated output you choose to use.

## 7. Limitation of liability

To the maximum extent permitted by law, the hosted gateway is provided **"as is"** without warranties of any kind. We are not liable for indirect, incidental, or consequential damages arising from your use of the service. Our total liability for any claim is limited to the amount you paid us for the service — which, for the free tier, is zero.

## 8. Termination

- You may stop using the service at any time by signing out (which revokes your tokens) — see the Privacy Policy for data deletion.
- We may suspend or terminate your access for violations of these Terms, particularly abuse of the free tier. For paid tiers (when introduced), termination terms will be stated at purchase.

## 9. Changes to these Terms

We may update these Terms as Sunday evolves. Material changes will be announced in the GitHub repository and, where feasible, in the IDE. Continued use of the hosted gateway after changes take effect constitutes acceptance.

## 10. Contact

Questions about these Terms: open an issue at [github.com/Vivek492005/Sunday/issues](https://github.com/Vivek492005/Sunday/issues).

---

*The Sunday IDE software is © 2026 and licensed under Apache-2.0. These Terms apply only to the hosted gateway service described above.*
