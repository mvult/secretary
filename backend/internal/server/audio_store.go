package server

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type audioStore interface {
	upload(context.Context, string, string, int64) (string, http.Header, error)
	download(context.Context, string) (string, error)
	verify(context.Context, string, string, int64) error
	delete(context.Context, string) error
}

type b2AudioStore struct {
	client *s3.Client
	signer *s3.PresignClient
	bucket string
}

func (s *Server) ConfigureAudioStorage(endpoint, region, bucket, keyID, key string) error {
	if endpoint == "" && region == "" && bucket == "" && keyID == "" && key == "" {
		return nil
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || region == "" || bucket == "" || keyID == "" || key == "" {
		return errors.New("B2_ENDPOINT (https), B2_REGION, B2_BUCKET, B2_KEY_ID and B2_APPLICATION_KEY are required")
	}
	client := s3.New(s3.Options{Region: region, BaseEndpoint: aws.String(endpoint), UsePathStyle: true,
		Credentials:                credentials.NewStaticCredentialsProvider(keyID, key, ""),
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
		HTTPClient:                 &http.Client{Timeout: 30 * time.Second}})
	s.audio = &b2AudioStore{client: client, signer: s3.NewPresignClient(client), bucket: bucket}
	return nil
}

func (b *b2AudioStore) upload(ctx context.Context, key, contentType string, size int64) (string, http.Header, error) {
	result, err := b.signer.PresignPutObject(ctx, &s3.PutObjectInput{Bucket: &b.bucket, Key: &key,
		ContentType: &contentType, ContentLength: &size}, s3.WithPresignExpires(30*time.Minute))
	if err != nil {
		return "", nil, err
	}
	return result.URL, result.SignedHeader, nil
}
func (b *b2AudioStore) download(ctx context.Context, key string) (string, error) {
	result, err := b.signer.PresignGetObject(ctx, &s3.GetObjectInput{Bucket: &b.bucket, Key: &key}, s3.WithPresignExpires(6*time.Hour))
	if err != nil {
		return "", err
	}
	return result.URL, nil
}
func (b *b2AudioStore) verify(ctx context.Context, key, contentType string, size int64) error {
	result, err := b.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &b.bucket, Key: &key})
	if err != nil {
		return err
	}
	if aws.ToInt64(result.ContentLength) != size || aws.ToString(result.ContentType) != contentType {
		return errors.New("uploaded audio size or content type does not match")
	}
	return nil
}
func (b *b2AudioStore) delete(ctx context.Context, key string) error {
	_, err := b.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &b.bucket, Key: &key})
	return err
}

func (s *Server) recordingAudioURL(ctx context.Context, key, legacyURL string) (string, error) {
	if key == "" {
		return legacyURL, nil
	}
	if s.audio == nil {
		return "", errors.New("B2 storage is not configured")
	}
	return s.audio.download(ctx, key)
}
