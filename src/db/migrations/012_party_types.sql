-- Customers are either distributors or retailers. Everything that was a customer before is a retailer until changed.
ALTER TABLE partner ADD COLUMN customer_type text CHECK (customer_type IN ('distributor','retailer'));
UPDATE partner SET customer_type = 'retailer' WHERE is_customer;
CREATE INDEX partner_customer_type ON partner(customer_type) WHERE is_customer;
