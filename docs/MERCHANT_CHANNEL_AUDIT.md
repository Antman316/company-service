# Merchant contact-channel audit — V1 launch set

Status: **CONTACT_CONFIRMED research pass** — compiled 2026-10-06 from each
merchant's official support pages. Per the honest-label rules: a row here
says only that the channel is published on the official site. A lane becomes
**VERIFIED** only after a real customer case is observed working through it.

Legend: **email** = a support email address is published on the official
site · **form** = a web contact form / ticket flow is published (reply by
email) · **chat** = live chat or bot→agent chat is published · **none** =
no asynchronous lane found (phone/store only).

| Merchant | email | form | chat | Notes | Official source(s) |
|---|---|---|---|---|---|
| Amazon | — | — | yes | Bot → live associate, 24/7; phone callback via chat flow. No public support email. | https://www.amazon.com/gp/help/customer/contact-us · https://www.aboutamazon.com/news/company-news/contact-amazon-customer-service |
| Walmart | — | — | yes | Help Center chat (bot → live agent) + 1-800-925-6278. | https://corporate.walmart.com/about/contact · https://www.walmart.com/help |
| Target | — | — | yes | Target Chat in Help Center + guided contact flow; 1-800-591-3869. | https://www.target.com/help/contact-us · https://contactus.target.com/ContactUs/ |
| Best Buy | — | — | yes | "Chat Now" live agents + 1-888-237-8289. No support email. | https://www.bestbuy.com/site/help-topics/contact/pcmcat1511375025410.c |
| Costco | — | — | yes | Official answer: "Costco does not offer email support" — phone + chat only. | https://customerservice.costco.com/app/answers/detail/a_id/8108 · https://customerservice.costco.com/app/answers/detail/a_id/9 |
| Home Depot | — | — | yes | On-site live chat + 1-800-466-3337. (`help@homedepotpartstore.com` exists but is scoped to the parts store, not general support.) | https://corporate.homedepot.com/page/contact-us · https://www.homedepot.com/c/customer_service |
| Lowe's | — | yes | yes | Phone, chat, "online message" per official privacy statement; Mylow assistant + agent chat. | https://www.lowes.com/l/help · https://corporate.lowes.com/contact-us · https://www.lowes.com/l/about/privacy-and-security-statement |
| Chewy | **service@chewy.com** | — | yes | Email + 24/7 phone + live chat. Email lane already VERIFIED on prod. | https://www.chewy.com/app/content/privacy · https://www.chewy.com/app/content/contact |
| Wayfair | — | — | yes | Virtual assistant → agent chat; no published email. | https://www.wayfair.com/help · https://www.wayfair.com/contact_us |
| eBay | — | yes | yes | Help-portal flow → automated assistant → live agent; message/email via the portal form; callback on request. No direct email address. | https://www.ebay.com/help/home · https://www.ebay.com/help/contact |
| Etsy | — | yes | partial | Buyers: "Submit a request" ticket form (sign-in required). Live chat exists for sellers in Shop Manager only. No phone. | https://help.etsy.com/hc/en-us/requests/new · https://help.etsy.com/hc/en-gb/articles/115013375488 |
| Nike | — | — | yes | Salesforce LiveChat + Virtual Assistant + 1-800-806-6453. No email. | https://www.nike.com/help/ · https://www.nike.com/at/en/help/a/nike-contact-directory |
| Apple | — | — | yes | Chat via Support app/Messages + phone. No support email. | https://support.apple.com/contact · https://support.apple.com/en-us/106932 |
| Samsung | — | — | yes | 24/7 chat + text/WhatsApp + 1-800-726-7864. No US support email published. | https://www.samsung.com/us/support/contact/ · https://www.samsung.com/us/support/chat/ |
| Dell | — | yes | yes | Chat + phone + "Contact Order Support" flow after device/order identification. | https://www.dell.com/en-us/lp/contact-us |
| Zappos | **cs@support.zappos.com** | — | yes | Email + live chat + text + 24/7 phone. Email address published on official help pages. | https://www.zappos.com/c/contact-us · https://www.zappos.com/customer-service-center |
| Nordstrom | — | — | yes | AI chat → human representative + 1-888-282-6060. No published order-support email (privacy requests have a separate form/address). | https://www.nordstrom.com/browse/customer-service · https://www.nordstrom.com/browse/customer-service/policy/privacy |
| Macy's | — | — | yes | macys.com/webchat + 1-800-289-6229. No email. | https://www.macys.com/webchat · https://www.macys.com/customer-service/articles/contact-us |
| Kohl's | — | — | yes | Official: "We do not offer an option to email an associate." Chat 24/7 + phone. | https://cs.kohls.com/app/answers/help_topic/c/27 |
| Sephora | **customerservice@sephora.com** | — | yes | Email published in Terms of Use for disputes + chat + phone. | https://www.sephora.com/beauty/terms-of-use · https://www.sephora.com/beauty/contact-us |
| Ulta | — | yes | yes | "Email Us" contact form (topic flow) + chat (Virtual Assistant → specialist) + text + 1-866-983-8582. | https://www.ulta.com/guestservices/contact-us · https://www.ulta.com/guestservices/all |
| Temu | — | — | yes | 24/7 chat support; US contact page routes to in-app chat. (contact-us@emea.temu.com exists but is EMEA-scoped.) | https://www.temu.com/contact-us.html |
| Shein | **uscsteam@shein.com** | — | yes | Email published on official US imprint + live chat (4 AM–8 PM PST) + phone. | https://m.shein.com/us/imprint-a-746.html · https://m.shein.com/us/SHEIN-Customer-Care-FAQ-a-1012.html |
| IKEA | — | — | yes | Chat (Billie → representative) + 1-888-888-4532. No published email. | https://www.ikea.com/us/en/customer-service/ |
| Newegg | — | — | yes | Live chat 6 AM–5 PM PST + 1-800-390-1119. Orders/support not taken by email. | https://kb.newegg.com/contact-us/ |

## Findings

- **Published support email: 4 of 25** — Chewy (VERIFIED on prod), Zappos,
  Sephora, Shein. Two more publish a regional or scoped address
  (Temu-EMEA, Home Depot parts) that is not a general support lane.
- **Web contact form: 5 of 25** — Lowe's, eBay, Etsy, Dell, Ulta. These are
  **ASSISTED `form` lanes**: the agent drafts, the customer pastes/submits;
  the M5 extension can prefill.
- **Chat: 25 of 25** — every launch merchant offers chat or a bot→agent
  flow. Per R6 this makes the chat companion (M5) the critical path for
  the ≥15-VERIFIED-lane gate, not email.
- **None:** zero merchants are truly unreachable — every one has at least
  chat.

Implication baked into the spec: `CONTACT_CONFIRMED` rows seed from this
audit; `VERIFIED` only from real cases; M5 builds ahead of M2 polish.
