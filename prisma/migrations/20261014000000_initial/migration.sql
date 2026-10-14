-- Criar tabela
CREATE TABLE `fiscal_certificates` (
    `id` CHAR(36) NOT NULL,
    `cnpj` CHAR(14) NOT NULL,
    `subjectName` VARCHAR(250) NOT NULL,
    `validFrom` DATETIME(3) NOT NULL,
    `validUntil` DATETIME(3) NOT NULL,
    `fingerprint` CHAR(64) NOT NULL,
    `fileCipher` LONGTEXT NOT NULL,
    `passwordCipher` TEXT NOT NULL,
    `status` ENUM('ACTIVE', 'REPLACED', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
    `activeSlot` VARCHAR(36) NOT NULL DEFAULT 'active',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `fiscal_certificates_cnpj_activeSlot_key`(`cnpj`, `activeSlot`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Criar tabela
CREATE TABLE `fiscal_city_configs` (
    `id` CHAR(36) NOT NULL,
    `cnpj` CHAR(14) NOT NULL,
    `cityCode` INTEGER UNSIGNED NOT NULL,
    `environment` ENUM('HOMOLOGATION', 'PRODUCTION') NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `series` VARCHAR(5) NOT NULL DEFAULT '1',
    `cancellationWindowDays` SMALLINT UNSIGNED NULL,
    `webhookUrl` VARCHAR(2048) NULL,
    `webhookSecretCipher` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `fiscal_city_configs_cnpj_cityCode_environment_key`(`cnpj`, `cityCode`, `environment`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Criar tabela
CREATE TABLE `fiscal_dps_sequences` (
    `cnpj` CHAR(14) NOT NULL,
    `environment` ENUM('HOMOLOGATION', 'PRODUCTION') NOT NULL,
    `series` VARCHAR(5) NOT NULL,
    `nextNumber` INTEGER UNSIGNED NOT NULL DEFAULT 1,

    PRIMARY KEY (`cnpj`, `environment`, `series`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Criar tabela
CREATE TABLE `fiscal_invoices` (
    `id` CHAR(36) NOT NULL,
    `cnpj` CHAR(14) NOT NULL,
    `environment` ENUM('HOMOLOGATION', 'PRODUCTION') NOT NULL,
    `externalId` VARCHAR(200) NOT NULL,
    `idempotencyKey` VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `request` JSON NOT NULL,
    `cityCode` INTEGER UNSIGNED NOT NULL,
    `series` VARCHAR(5) NOT NULL,
    `number` INTEGER UNSIGNED NOT NULL,
    `dpsId` CHAR(42) NOT NULL,
    `issuedAt` DATETIME(3) NOT NULL,
    `signedDpsXml` LONGTEXT NOT NULL,
    `certificateId` CHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'AUTHORIZED', 'REJECTED', 'CANCELED') NOT NULL DEFAULT 'PENDING',
    `accessKey` VARCHAR(60) NULL,
    `authorizedXml` LONGTEXT NULL,
    `authorizedAt` DATETIME(3) NULL,
    `cancellationKey` VARCHAR(200) NULL,
    `cancellationHash` CHAR(64) NULL,
    `cancellationRequest` JSON NULL,
    `cancellationStatus` VARCHAR(20) NULL,
    `signedCancellationXml` LONGTEXT NULL,
    `cancellationEventXml` LONGTEXT NULL,
    `webhookUrl` VARCHAR(2048) NULL,
    `webhookSecretCipher` TEXT NULL,
    `lastError` VARCHAR(1000) NULL,
    `attemptCount` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `fiscal_invoices_cnpj_status_idx`(`cnpj`, `status`),
    UNIQUE INDEX `fiscal_invoices_cnpj_environment_idempotencyKey_key`(`cnpj`, `environment`, `idempotencyKey`),
    UNIQUE INDEX `fiscal_invoices_cnpj_environment_series_number_key`(`cnpj`, `environment`, `series`, `number`),
    UNIQUE INDEX `fiscal_invoices_environment_dpsId_key`(`environment`, `dpsId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Criar tabela
CREATE TABLE `fiscal_events` (
    `id` CHAR(36) NOT NULL,
    `invoiceId` CHAR(36) NOT NULL,
    `type` VARCHAR(50) NOT NULL,
    `code` VARCHAR(30) NULL,
    `message` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `fiscal_events_invoiceId_createdAt_idx`(`invoiceId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Criar tabela
CREATE TABLE `fiscal_tasks` (
    `id` CHAR(36) NOT NULL,
    `invoiceId` CHAR(36) NOT NULL,
    `kind` ENUM('ISSUE', 'CANCEL', 'WEBHOOK') NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'DONE', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `payload` JSON NULL,
    `attempts` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `availableAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lockUntil` DATETIME(3) NULL,
    `lockOwner` CHAR(36) NULL,
    `lastError` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `fiscal_tasks_status_availableAt_idx`(`status`, `availableAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Adicionar chave estrangeira
ALTER TABLE `fiscal_invoices` ADD CONSTRAINT `fiscal_invoices_certificateId_fkey` FOREIGN KEY (`certificateId`) REFERENCES `fiscal_certificates`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Adicionar chave estrangeira
ALTER TABLE `fiscal_events` ADD CONSTRAINT `fiscal_events_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `fiscal_invoices`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Adicionar chave estrangeira
ALTER TABLE `fiscal_tasks` ADD CONSTRAINT `fiscal_tasks_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `fiscal_invoices`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

