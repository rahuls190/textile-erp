-- Fuller addresses: second line, contact at the address, default per kind.
ALTER TABLE partner_address
  ADD COLUMN line2        text,
  ADD COLUMN label        text,
  ADD COLUMN contact_name text,
  ADD COLUMN phone        text,
  ADD COLUMN gstin        text,
  ADD COLUMN is_default   boolean NOT NULL DEFAULT false;
-- the oldest address of each kind becomes that kind's default
UPDATE partner_address a SET is_default = true
 WHERE a.id = (SELECT b.id FROM partner_address b WHERE b.partner_id=a.partner_id AND b.kind=a.kind ORDER BY b.created_at, b.id LIMIT 1);
CREATE UNIQUE INDEX partner_address_default ON partner_address(partner_id, kind) WHERE is_default;
