package casdoor

import "context"

// FakeClient is an in-memory Client for envtest reconciler tests.
type FakeClient struct {
	Apps         map[string]Application // keyed by app name
	AddCalls     int
	UpdateCalls  int
	DeleteCalls  int
	CreateSecret func(name string) string // optional override for generated secret
	GetErr       error
}

func NewFake() *FakeClient { return &FakeClient{Apps: map[string]Application{}} }

func (f *FakeClient) defaultSecret(name string) string {
	if f.CreateSecret != nil {
		return f.CreateSecret(name)
	}
	return "secret-for-" + name
}

func (f *FakeClient) GetApplication(_ context.Context, name string) (Application, bool, error) {
	if f.GetErr != nil {
		return nil, false, f.GetErr
	}
	a, ok := f.Apps[name]
	return a, ok, nil
}

func (f *FakeClient) AddApplication(_ context.Context, app Application) (Application, error) {
	f.AddCalls++
	name := app[FieldName].(string)
	app[FieldClientSecret] = f.defaultSecret(name)
	if _, ok := app[FieldClientID].(string); !ok {
		app[FieldClientID] = name
	}
	f.Apps[name] = app
	return app, nil
}

func (f *FakeClient) UpdateApplication(_ context.Context, app Application) error {
	f.UpdateCalls++
	name := app[FieldName].(string)
	// Preserve existing secret if caller did not set one.
	if _, ok := app[FieldClientSecret]; !ok {
		if existing, found := f.Apps[name]; found {
			app[FieldClientSecret] = existing[FieldClientSecret]
		}
	}
	f.Apps[name] = app
	return nil
}

func (f *FakeClient) DeleteApplication(_ context.Context, app Application) error {
	f.DeleteCalls++
	delete(f.Apps, AppName(app))
	return nil
}
