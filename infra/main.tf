module "ecr" {
  source = "./modules/ecr"

  project_name = var.project_name
}

module "iam" {
  source = "./modules/iam"

  project_name = var.project_name
}
