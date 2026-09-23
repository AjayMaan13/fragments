terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Local state for now (Phase 1). Once Phase 0's bootstrap/ creates the
  # remote state bucket + lock table, add a `backend "s3" {}` block here
  # and run `terraform init -migrate-state`.
}

provider "aws" {
  region = var.aws_region
}
