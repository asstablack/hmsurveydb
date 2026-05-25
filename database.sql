CREATE DATABASE IF NOT EXISTS survey_record_management;
USE survey_record_management;

CREATE TABLE IF NOT EXISTS surveys (
    id BIGINT PRIMARY KEY,
    survey_number VARCHAR(100) NOT NULL UNIQUE,
    survey_name VARCHAR(255) NOT NULL,
    surveyor VARCHAR(150) NOT NULL,
    local_gov VARCHAR(150),
    job_type VARCHAR(100),
    survey_date DATE,
    easting DOUBLE,
    northing DOUBLE,
    payload JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_survey_number (survey_number),
    INDEX idx_survey_name (survey_name),
    INDEX idx_surveyor (surveyor),
    INDEX idx_survey_date (survey_date)
);
