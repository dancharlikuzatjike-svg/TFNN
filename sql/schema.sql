-- TFNN Farm Management System - database schema
-- Run with: psql $DATABASE_URL -f sql/schema.sql

CREATE TABLE IF NOT EXISTS users (
    user_id       SERIAL PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    phone         VARCHAR(20) UNIQUE NOT NULL,
    role          VARCHAR(20) NOT NULL CHECK (role IN ('farmer','admin','supplier','vet')),
    farm_location VARCHAR(150),
    password_hash TEXT NOT NULL,
    active        BOOLEAN DEFAULT true,
    created_at    TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS animal (
    animal_id     SERIAL PRIMARY KEY,
    tag_number    VARCHAR(30) NOT NULL,
    species       VARCHAR(20) NOT NULL CHECK (species IN ('Cattle','Sheep','Goat')),
    breed         VARCHAR(50),
    class         VARCHAR(20),
    date_of_birth DATE,
    owner_id      INT NOT NULL REFERENCES users(user_id),
    mother_id     INT REFERENCES animal(animal_id),
    father_id     INT REFERENCES animal(animal_id),
    status        VARCHAR(20) DEFAULT 'Active' CHECK (status IN ('Active','Sold','Deceased')),
    created_at    TIMESTAMP DEFAULT now(),
    UNIQUE (owner_id, tag_number)
);
CREATE INDEX IF NOT EXISTS idx_animal_owner ON animal(owner_id);

CREATE TABLE IF NOT EXISTS animal_event (
    event_id    SERIAL PRIMARY KEY,
    animal_id   INT NOT NULL REFERENCES animal(animal_id) ON DELETE CASCADE,
    event_date  DATE NOT NULL,
    event_type  VARCHAR(30) NOT NULL,
    notes       TEXT,
    created_by  INT REFERENCES users(user_id),
    created_at  TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_animal ON animal_event(animal_id);
CREATE INDEX IF NOT EXISTS idx_event_date ON animal_event(event_date);

CREATE TABLE IF NOT EXISTS task (
    task_id     SERIAL PRIMARY KEY,
    farmer_id   INT NOT NULL REFERENCES users(user_id),
    title       VARCHAR(150) NOT NULL,
    due_date    DATE,
    done        BOOLEAN DEFAULT false,
    source      VARCHAR(20) DEFAULT 'manual',
    created_at  TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_farmer ON task(farmer_id);

CREATE TABLE IF NOT EXISTS feed_listing (
    listing_id   SERIAL PRIMARY KEY,
    supplier_id  INT NOT NULL REFERENCES users(user_id),
    feed_type    VARCHAR(100) NOT NULL,
    unit         VARCHAR(20),
    price        NUMERIC(10,2),
    available    BOOLEAN DEFAULT true,
    created_at   TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feed_order (
    order_id     SERIAL PRIMARY KEY,
    farmer_id    INT NOT NULL REFERENCES users(user_id),
    supplier_id  INT NOT NULL REFERENCES users(user_id),
    listing_id   INT REFERENCES feed_listing(listing_id),
    quantity     NUMERIC(10,2) NOT NULL,
    need_by      DATE,
    status       VARCHAR(20) DEFAULT 'Requested' CHECK (status IN ('Requested','Confirmed','Delivered','Cancelled')),
    notes        TEXT,
    created_at   TIMESTAMP DEFAULT now(),
    updated_at   TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_farmer ON feed_order(farmer_id);
CREATE INDEX IF NOT EXISTS idx_order_supplier ON feed_order(supplier_id);

-- Farm-level costs that aren't tied to a single animal (e.g. a feed delivery)
CREATE TABLE IF NOT EXISTS expense (
    expense_id   SERIAL PRIMARY KEY,
    farmer_id    INT NOT NULL REFERENCES users(user_id),
    amount       NUMERIC(10,2),
    category     VARCHAR(30), -- e.g. 'Feed', 'Vet', 'Equipment'
    description  TEXT,
    expense_date DATE DEFAULT CURRENT_DATE,
    ref_type     VARCHAR(20), -- e.g. 'feed_order', 'vet_request' - lets you trace it back
    ref_id       INT,
    created_at   TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expense_farmer ON expense(farmer_id);

CREATE TABLE IF NOT EXISTS vet_profile (
    vet_id        INT PRIMARY KEY REFERENCES users(user_id),
    service_area  VARCHAR(150),
    specialty     VARCHAR(50),
    on_call       BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS vet_request (
    request_id  SERIAL PRIMARY KEY,
    farmer_id   INT NOT NULL REFERENCES users(user_id),
    animal_id   INT REFERENCES animal(animal_id),
    vet_id      INT REFERENCES users(user_id),
    urgency     VARCHAR(20) NOT NULL CHECK (urgency IN ('Routine','Urgent','Emergency')),
    phone       VARCHAR(20) NOT NULL,
    notes       TEXT,
    status      VARCHAR(20) DEFAULT 'Pending' CHECK (status IN ('Pending','Assigned','Resolved','Cancelled')),
    resolution_notes TEXT,
    created_at  TIMESTAMP DEFAULT now(),
    resolved_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vetreq_farmer ON vet_request(farmer_id);
CREATE INDEX IF NOT EXISTS idx_vetreq_status ON vet_request(status);
-- Record-keeping improvements for animal_event
-- Append this to the BOTTOM of sql/schema.sql, then re-run your usual
-- migrate step (temporarily set Start Command to `npm run migrate && npm start`
-- on Render, redeploy, then revert). Safe to re-run: all statements are idempotent.

ALTER TABLE animal_event ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE animal_event ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE animal_event ADD COLUMN IF NOT EXISTS superseded_by INT REFERENCES animal_event(event_id);

CREATE INDEX IF NOT EXISTS idx_event_deleted ON animal_event(deleted_at);
CREATE INDEX IF NOT EXISTS idx_event_superseded ON animal_event(superseded_by);
-- Sales, valuation & expense soft-delete additions
-- Append this to the BOTTOM of sql/schema.sql, then re-run your usual
-- migrate step (Start Command -> `npm run migrate && npm start`, redeploy, revert).
-- Safe to re-run: all statements are idempotent.

CREATE TABLE IF NOT EXISTS sale (
    sale_id        SERIAL PRIMARY KEY,
    animal_id      INT NOT NULL REFERENCES animal(animal_id),
    seller_id      INT NOT NULL REFERENCES users(user_id),
    buyer_name     VARCHAR(150) NOT NULL,
    buyer_user_id  INT REFERENCES users(user_id),
    price          NUMERIC(10,2) NOT NULL,
    sale_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    payment_status VARCHAR(20) DEFAULT 'Pending' CHECK (payment_status IN ('Pending','Paid','Partial','Cancelled')),
    notes          TEXT,
    deleted_at     TIMESTAMP,
    created_at     TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sale_seller ON sale(seller_id);
CREATE INDEX IF NOT EXISTS idx_sale_animal ON sale(animal_id);

-- A farmer's own estimate of what a live animal is currently worth
ALTER TABLE animal ADD COLUMN IF NOT EXISTS estimated_value NUMERIC(10,2);

-- expense never had soft delete - bringing it in line with the rest of the system
ALTER TABLE expense ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
-- Auto-generated task tracking additions
-- Append this to the BOTTOM of sql/schema.sql, then re-run your usual
-- migrate step (Start Command -> `npm run migrate && npm start`, redeploy, revert).
-- Safe to re-run: all statements are idempotent.

ALTER TABLE task ADD COLUMN IF NOT EXISTS ref_type VARCHAR(20);
ALTER TABLE task ADD COLUMN IF NOT EXISTS ref_id INT;
CREATE INDEX IF NOT EXISTS idx_task_ref ON task(ref_type, ref_id);
-- Photo and voice note attachments
-- Append this to the BOTTOM of sql/schema.sql, then re-run your usual
-- migrate step (Start Command -> `npm run migrate && npm start`, redeploy, revert).
-- Safe to re-run: all statements are idempotent.

CREATE TABLE IF NOT EXISTS media (
    media_id    SERIAL PRIMARY KEY,
    owner_id    INT NOT NULL REFERENCES users(user_id),
    ref_type    VARCHAR(20) NOT NULL CHECK (ref_type IN ('animal','animal_event')),
    ref_id      INT NOT NULL,
    kind        VARCHAR(10) NOT NULL CHECK (kind IN ('photo','voice')),
    mime_type   VARCHAR(50) NOT NULL,
    data        BYTEA NOT NULL,
    size_bytes  INT NOT NULL,
    client_id   UUID,
    created_at  TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_ref ON media(ref_type, ref_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_client_id ON media(client_id);
-- Farmer-to-farmer marketplace listings
-- Append this to the BOTTOM of sql/schema.sql, then re-run your usual
-- migrate step (Start Command -> `npm run migrate && npm start`, redeploy, revert).
-- Safe to re-run: all statements are idempotent.

CREATE TABLE IF NOT EXISTS marketplace_listing (
    listing_id   SERIAL PRIMARY KEY,
    animal_id    INT NOT NULL REFERENCES animal(animal_id),
    seller_id    INT NOT NULL REFERENCES users(user_id),
    asking_price NUMERIC(10,2),
    description  TEXT,
    status       VARCHAR(20) DEFAULT 'Open' CHECK (status IN ('Open','Reserved','Sold','Cancelled')),
    client_id    UUID,
    created_at   TIMESTAMP DEFAULT now(),
    updated_at   TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_listing_seller ON marketplace_listing(seller_id);
CREATE INDEX IF NOT EXISTS idx_listing_status ON marketplace_listing(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_client_id ON marketplace_listing(client_id);
-- District field + outbreak alerts
-- Append this to the BOTTOM of sql/schema.sql, then re-run your usual
-- migrate step (Start Command -> `npm run migrate && npm start`, redeploy, revert).
-- Safe to re-run: all statements are idempotent.

-- Structured region, separate from the free-text farm_location, so price
-- aggregation and alerts can be reliably grouped/filtered by district.
ALTER TABLE users ADD COLUMN IF NOT EXISTS district VARCHAR(30);

CREATE TABLE IF NOT EXISTS district_alert (
    alert_id     SERIAL PRIMARY KEY,
    district     VARCHAR(30) NOT NULL,
    title        VARCHAR(150) NOT NULL,
    description  TEXT,
    severity     VARCHAR(20) DEFAULT 'Advisory' CHECK (severity IN ('Advisory','Warning','Emergency')),
    status       VARCHAR(20) DEFAULT 'Active' CHECK (status IN ('Active','Resolved')),
    posted_by    INT NOT NULL REFERENCES users(user_id),
    expires_at   TIMESTAMP,
    created_at   TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alert_district ON district_alert(district);
CREATE INDEX IF NOT EXISTS idx_alert_status ON district_alert(status);
-- Consolidated client_id fix - covers every table the deployed code expects
-- a client_id column on. Safe to run even if some of these were already
-- applied individually before; every statement is idempotent.

ALTER TABLE animal ADD COLUMN IF NOT EXISTS client_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_animal_client_id ON animal(client_id);

ALTER TABLE animal_event ADD COLUMN IF NOT EXISTS client_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_client_id ON animal_event(client_id);

ALTER TABLE sale ADD COLUMN IF NOT EXISTS client_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_client_id ON sale(client_id);

ALTER TABLE expense ADD COLUMN IF NOT EXISTS client_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_client_id ON expense(client_id);

ALTER TABLE task ADD COLUMN IF NOT EXISTS client_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_client_id ON task(client_id);

ALTER TABLE media ADD COLUMN IF NOT EXISTS client_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_client_id ON media(client_id);

ALTER TABLE marketplace_listing ADD COLUMN IF NOT EXISTS client_id UUID;
-- Account approval gate for supplier/vet roles
-- Append this to the BOTTOM of sql/schema.sql, then re-run your usual
-- migrate step (Start Command -> `npm run migrate && npm start`, redeploy, revert).
-- Safe to re-run: all statements are idempotent.
--
-- Default true so every existing user (all currently-trusted farmers/suppliers/
-- vets already in the database) keeps working without being locked out.
-- New supplier/vet signups explicitly get approved=false at insert time.
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT true;CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_client_id ON marketplace_listing(client_id);
