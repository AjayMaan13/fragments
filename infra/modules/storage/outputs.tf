output "bucket_name" {
  value = aws_s3_bucket.fragments.bucket
}

output "bucket_arn" {
  value = aws_s3_bucket.fragments.arn
}

output "table_name" {
  value = aws_dynamodb_table.fragments.name
}

output "table_arn" {
  value = aws_dynamodb_table.fragments.arn
}
