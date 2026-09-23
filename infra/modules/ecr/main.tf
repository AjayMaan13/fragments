resource "aws_ecr_repository" "this" {
  name                 = var.project_name
  image_tag_mutability = "MUTABLE"

  # Lets `terraform destroy` delete the repo even when it contains images.
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }
}
