# Contact history and missed calls in the leads CRM

A staff member opens **לידים → שיחות והודעות לשיוך** on a phone or computer. A new, shared or withheld number goes into this queue. Staff verify a single event against an open lead. For a unique patient or referral-contact number they can also remember the match for future events. An explicit **ביטול השיוך האוטומטי למספר** action on the lead's activity tab withdraws that grant. The historical record stays on the card.

The activity tab shows inbound and outbound PBX calls and private WhatsApp events. It distinguishes provider-confirmed sent, delivered and read states, failed delivery and the presence of a file. Ringing an extension, opening a draft or receiving a duplicate acknowledgment does not create a second interaction. The contact desk sees metadata; message text, file links, recordings and clinical notes are excluded. Staff can dismiss an unrelated interaction.

An inbound whole-call final miss creates one ordinary callback task once linked. It goes to the current lead owner (Vered, Dana or Sandra) with Vered as the intake fallback and the call date in Israel. An authoritative answer can correct a late miss; cancellation affects only the original, untouched system task. Opening the task tab reads the current tasks for that card, including work created in another session. The CRM uses its existing, short-lived read cache.

The normalized intake interface has its own server credential and validates the configured WhatsApp line and the approved PBX numbers separately. This change contains no PayCall wire adapter or outbound messaging path. The assistant's crisis and human takeover rules stay in its separate intake service. The operational setup and synthetic request contract are in DEPLOY.md.
