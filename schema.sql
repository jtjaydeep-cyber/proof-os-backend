-- Create Enums
CREATE TYPE "IdentityTrustLevel" AS ENUM ('LEVEL_0', 'LEVEL_1', 'LEVEL_2', 'LEVEL_3', 'LEVEL_4');
CREATE TYPE "EvidenceClass" AS ENUM ('CLASS_A', 'CLASS_B', 'CLASS_C', 'CLASS_D', 'CLASS_E', 'CLASS_F');

-- Create Users Table
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "identityTrustLevel" "IdentityTrustLevel" NOT NULL DEFAULT 'LEVEL_0',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- Create Evidence Artifacts Table
CREATE TABLE "evidence_artifacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "eClass" "EvidenceClass" NOT NULL,
    "sourceUri" TEXT NOT NULL,
    "aiConfidenceScore" DOUBLE PRECISION DEFAULT 0.0,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_artifacts_pkey" PRIMARY KEY ("id")
);

-- Create Unique Index & Foreign Key
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

ALTER TABLE "evidence_artifacts" ADD CONSTRAINT "evidence_artifacts_userId_fkey" 
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
