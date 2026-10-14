-- Master data: material types, richer items, partner profile / contacts / addresses.

CREATE TABLE material_type (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('FABRIC','TRIM','CUP','PACKING','PROCESS','WIP','FG')),
  default_unit text NOT NULL REFERENCES unit(code),
  tracking     text NOT NULL DEFAULT 'LOT' CHECK (tracking IN ('NONE','LOT','ROLL')),
  -- [{key,label,type:'number'|'text',unit?,required?}] — what every material of this type must record
  attr_schema  jsonb NOT NULL DEFAULT '[]',
  code_prefix  text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by   uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE item
  ADD COLUMN material_type_id uuid REFERENCES material_type(id),
  ADD COLUMN description text,
  ADD COLUMN hsn_code text,
  ADD COLUMN gst_rate numeric(5,2),
  ADD COLUMN reorder_level numeric(18,4);

ALTER TABLE partner
  ADD COLUMN pan text,
  ADD COLUMN state text,
  ADD COLUMN city text,
  ADD COLUMN phone text,
  ADD COLUMN email text,
  ADD COLUMN payment_days int,
  ADD COLUMN notes text;

CREATE TABLE partner_contact (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partner(id),
  name       text NOT NULL,
  role       text,
  phone      text,
  email      text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_contact_p ON partner_contact(partner_id);

CREATE TABLE partner_address (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partner(id),
  kind       text NOT NULL CHECK (kind IN ('registered','billing','shipping','works')),
  line1      text NOT NULL,
  city       text,
  state      text,
  pincode    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_address_p ON partner_address(partner_id);
