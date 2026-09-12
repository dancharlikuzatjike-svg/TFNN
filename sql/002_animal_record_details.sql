-- Farmer-portal record details. Safe to run repeatedly on an existing TFNN database.
ALTER TABLE animal
  ADD COLUMN IF NOT EXISTS name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS sex VARCHAR(10) CHECK (sex IN ('Male', 'Female')),
  ADD COLUMN IF NOT EXISTS stock_brand VARCHAR(30),
  ADD COLUMN IF NOT EXISTS registration_status VARCHAR(20) DEFAULT 'Registered'
    CHECK (registration_status IN ('Registered', 'Pending', 'Not registered')),
  ADD COLUMN IF NOT EXISTS health_status VARCHAR(20) DEFAULT 'Healthy'
    CHECK (health_status IN ('Healthy', 'Needs attention', 'Under treatment')),
  ADD COLUMN IF NOT EXISTS condition_score SMALLINT CHECK (condition_score BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();

-- Backfill sex from the existing livestock class where the answer is unambiguous.
UPDATE animal SET sex = 'Male'
WHERE sex IS NULL AND class IN ('Bull', 'Bull calf', 'Steer', 'Ox', 'Ram', 'Ram lamb', 'Buck', 'Buck kid', 'Wether');

UPDATE animal SET sex = 'Female'
WHERE sex IS NULL AND class IN ('Cow', 'Heifer', 'Heifer calf', 'Ewe', 'Ewe lamb', 'Doe', 'Doe kid');

CREATE INDEX IF NOT EXISTS idx_animal_owner_species ON animal(owner_id, species);
CREATE INDEX IF NOT EXISTS idx_animal_owner_class ON animal(owner_id, class);
