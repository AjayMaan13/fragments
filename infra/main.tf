module "ecr" {
  source = "./modules/ecr"

  project_name = var.project_name
}

module "storage" {
  source = "./modules/storage"

  project_name = var.project_name
}

module "iam" {
  source = "./modules/iam"

  project_name = var.project_name
  bucket_arn   = module.storage.bucket_arn
  table_arn    = module.storage.table_arn
}
