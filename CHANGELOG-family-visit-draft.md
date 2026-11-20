# Family visit confirmation

The CRM and the classic meetings board prepare a Hebrew WhatsApp draft after a staff member saves a visit. The lead card also offers the draft for an existing, saved appointment. The message uses the house, date, time, approved address, navigation link and optional arrival instructions.

An authenticated, uncached read checks the open lead by its exact ID. The operator selects the patient or contact authorized for this visit and the dashboard checks the visit and recipient again before opening WhatsApp. Editing or cancelling the appointment, changing the recipient or losing the source connection invalidates the draft. No billing number or clinical note is included. Opening a draft records neither dispatch nor delivery. Staff send it inside WhatsApp.

The house directory setting is described in DEPLOY.md. Tests use invented addresses and a local substitute for Sheets. No Meta account or telephone provider is needed for this draft workflow.
